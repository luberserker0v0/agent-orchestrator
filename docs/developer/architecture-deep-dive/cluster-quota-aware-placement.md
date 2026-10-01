# Cluster Plan: Quota-Aware Placement with Per-Conversation Volumes

> **Status:** Design (locked). Target platform: Kubernetes. Goals: scale-out + HA.
> Shared infra: Redis (leases, event streams) + per-conversation RWO volumes + sticky ingress.
> This document is the single source of truth for the cluster build. Keep it updated as phases land.

## 1. Problem

A conversation runs on an agent instance bound to one machine (Machine A). When that
machine's LLM tokens are exhausted, the instance must stop receiving traffic and the
conversation must continue — losslessly, on the same model — on a healthy machine
(Machine B). A router must guarantee every request lands on a usable instance.

## 2. Current architecture (single-node assumptions)

All verified against the codebase; all must be addressed by the plan:

| Assumption | Evidence |
|---|---|
| All state in process heap: `ConversationState.states/instances/listeners/readyTokens`, `RuntimeManager.instances`, `PortPool`, `SSEBridge.clients`, `WSRouter.connections` | `src/orchestrator/conversation-state.ts:49-52`, `src/agent-runtime/runtime-manager.ts:22`, `src/orchestrator/port-pool.ts:16-17`, `src/orchestrator/sse-bridge.ts:14`, `src/websocket/router.ts:46-48` |
| Instances dialed via loopback: `baseUrl=http://instanceHost:port`, default `127.0.0.1`; port-free probe binds `127.0.0.1` | `src/agent-runtime/runtimes/direct.ts:76,91-92`, `src/agent-runtime/runtimes/docker.ts:106,123`, `src/orchestrator/port-pool.ts:9-12` |
| Workspaces on local disk; boot wipes `basePath` (`cleanupOrphans`); `ensure()` hardcodes `{type:'local'}` | `src/storage/local.ts:45-51,113-125`, `src/orchestrator/workspace-factory.ts:89,132,152-154` |
| `storage.type` only `'local'` accepted; anything else throws at startup | `src/config-loader.ts:368-370`, `src/index.ts:82-86` |
| WS is 1-connection-per-conversation with in-memory fan-out; SSE socket lives on spawner node | `src/websocket/router.ts:122-130,150-156`, `src/orchestrator/sse-bridge.ts:14,25-53` |
| `runtimes[]` not env-overridable (arrays opaque) — per-node topology needs distinct JSON files | `src/config-loader.ts:428-429` |
| **No quota signal exists**: `OpenCode HTTP 429` degrades to `500 INTERNAL_ERROR`; no `LLM_*` error code; no token accounting; SSE drops unknown event types | `src/http-api/server.ts:769`, `src/websocket/router.ts:183`, `src/utils/errors.ts:1-36`, `src/orchestrator/sse-bridge.ts:65-68` |
| **No retry/fallback** on any request path; `restart()` always creates a new session, discarding the old `sessionId` | `src/services/message-service.ts:78-82`, `src/services/conversation-service.ts:250-260` |
| OpenCode session history lives in the server OS data-dir (`~/.local/share/opencode/opencode.db`), **not** in `workspace/`; neither runtime mounts it | `src/agent-runtime/runtimes/direct.ts:98-106`, `src/agent-runtime/runtimes/docker.ts:139-144` |

Existing seams to build on: `AgentRuntime`/`RuntimeFactory`/`RuntimeRegistry` extensibility,
`RuntimeAccess` union (`local | docker-volume | docker`), arbitrary-`baseUrl` transports,
per-runtime `instanceHost`, auth-free `/health` + `/metrics`.

## 3. Verified session-persistence facts (real `opencode.db`)

Inspected `~/.local/share/opencode` (opencode SQLite layout):

- Sessions are portable `ses_*` rows in `opencode.db`; `project.id` is a hash of the
  absolute `worktree` path (matches `snapshot/<hash>/` dirs). Resume on another machine
  requires the **same DB file + byte-identical absolute workspace path**.
- DB runs in **WAL mode** — strictly single-writer. Drain-before-resume ordering is mandatory.
- Every `session` row carries `tokens_input/output/reasoning/cache_read/cache_write`,
  `cost`, `model` (`{providerID, id}`), `agent` — native token accounting the monitor
  can read; same-model targeting matches on the `model` JSON.

## 4. Locked design decisions

1. **Detection: parse provider errors.** Classify `429/402/403` + body match at
   `OpenCodeAgentClient.request()` into `LLM_QUOTA_EXHAUSTED` (migrate) vs
   `LLM_RATE_LIMITED` (back off). Token columns graduate to budget policy later.
2. **Migration: recreate + resume, lossless.** Same session on a new machine via shared
   storage — no replay cost, no context loss. Rollback to old instance on failure.
3. **Same model, always.** Target filter on `providerID/model.id`; no substitution.
4. **Time-based refill.** `QuotaPolicy.refillWindow` per model (seeded by `Retry-After`
   when present); controller re-probes after the window to clear `QuotaExhausted`.
5. **Partition, don't share, runtime handles.** PIDs, `AgentClient`s, SSE sockets, timers
   stay node-local. Share only records, route traffic to the owner.
6. **Per-conversation lifecycle-bound volume, single-writer.** One RWO volume per
   conversation; previous instance always down before remount → no lock contention,
   no RWX filesystem needed.

## 5. Per-conversation volume design

```text
PVC: conv-<id>   (dynamic provisioning, RWO; e.g. 10Gi default)
└── mount: /data/conversations/<convId>/     # IDENTICAL path on every machine
    ├── workspace/    # user data, outputs, .opencode/opencode.json
    └── session/      # XDG_DATA_HOME → opencode.db, snapshots, storage/
```

- One volume with two subpaths: workspace and session can never diverge; `cwd →
  projectHash` and `session.project_id` stay consistent by construction.
- `LocalStorage`/`WorkspaceFactory` work unchanged (they see local dirs); new code only
  plumbs `XDG_DATA_HOME=<mount>/session` + `cwd=<mount>/workspace` and verifies the
  mount on startup (expected entries present → else refuse with `WORKSPACE_CORRUPT`
  instead of booting a blank session over user data).
- `fsGroup: 1001` (matches Dockerfile `nodejs` uid).
- **Retention:** PVC deleted only on explicit conversation DELETE (API, `confirm=true`);
  never on migration, eviction, or idle timeout. Orphan-reaper removes PVCs whose
  conversation record is gone AND older than N days (configurable).

## 6. CRD #1 — `OpencodeInstance` (monitor the instance)

```yaml
apiVersion: agentorchestrator.io/v1alpha1
kind: OpencodeInstance
metadata: { name: conv-abc123, namespace: ao-instances }
spec:
  conversationId: conv-abc123
  nodeName: kind-worker2
  runtime: kubernetes                 # direct | docker | kubernetes
  endpoint: http://10.244.2.7:30042  # baseUrl equivalent
  model: { providerID: anthropic, id: claude-sonnet-4 }
  volumeClaimName: conv-abc123
  quotaPolicyRef: default
status:
  phase: Ready                        # Pending | Ready | QuotaExhausted | RateLimited | Failed | Terminating
  reachable: true
  lastHeartbeat: "2026-09-30T08:01:11Z"
  lastQuotaError: { code: 429, message: "...", at: "..." }
  consecutiveFailures: 3              # flap guard (default threshold 2)
  observedGeneration: 4
```

Writer: owning orchestrator (sees classified errors + health polls). Instance-Pod liveness
via `ownerReference`. `Ready → RateLimited` auto-recovers after backoff;
`Ready → QuotaExhausted` is sticky until refill probe passes.

## 7. CRD #2 — `ConversationRoute` (route to the usable machine)

```yaml
apiVersion: agentorchestrator.io/v1alpha1
kind: ConversationRoute
metadata: { name: conv-abc123, namespace: ao-instances }
spec:
  conversationId: conv-abc123
  desiredInstanceRef: conv-abc123-b   # set by operator during migration
status:
  currentInstanceRef: conv-abc123     # instance serving traffic NOW
  currentEndpoint: http://10.244.1.5:30011
  phase: Active                       # Active | Migrating | Draining
  conditions:
    - { type: Routable, status: "True", lastTransitionTime: ... }
  migrationHistory:
    - { from: conv-abc123, to: conv-abc123-b, reason: QuotaExhausted, at: ... }
```

Router contract: unified `ensureReady()` resolves the route (informer cache, 5–10s stale
tolerance) before touching the local map. Local match → today's path. Remote match →
proxy to the owning orchestrator. Absent CR → today's behavior (backward compatible).

## 8. Operator — `agent-orchestrator-controller`

Dedicated `Deployment` (1 replica + leader election). Watches both CRDs:

```text
OpencodeInstance → QuotaExhausted
 │ 1. route → Migrating (reads still served from old; writes get 409 MIGRATING + Retry-After)
 │ 2. select target: phase=Ready + SAME model + different nodeName (+ headroom)
 │ 3. target orchestrator mounts SAME PVC, starts instance, verifies GET /session/<sameSid>
 │ 4. route flips currentInstanceRef/Endpoint → Active + migrationHistory entry
 │ 5. drain old → destroy → object GC'd
No healthy target → wait with Routable=False, fail fast 503 QUOTA_EXHAUSTED_ALL.
Seed failure → rollback currentInstanceRef, serve degraded.
```

RBAC: namespaced `Role` on `ao-instances` (full verbs on both CRDs; `get/list/watch` pods).

## 9. End-to-end scenario

1. WS sticky to Orchestrator-A (owns `conv-X` on Machine A) → `sendPrompt`.
2. Provider 429-quota → classified → metric + `conversation.quotaExhausted` event
   ("quota hit, migrating…") → `OpencodeInstance: QuotaExhausted`.
3. Controller → `Migrating` → Machine B mounts same PVC → resumes **same session** →
   health-verified → route flips to `Active`.
4. Router (any node) resolves B; traffic flows. Old instance drained + destroyed.
5. After `refillWindow`, controller re-probes A (token-free `GET /session` list) →
   success clears to `Ready` (history intact in its DB copy).

## 10. K8s resources

| Resource | Purpose |
|---|---|
| `Deployment` orchestrator (N=3), `Service` ClusterIP (+ headless for per-Pod DNS), sticky `Ingress` (NGINX cookie/hash, WS upgrades) | App tier; `terminationGracePeriodSeconds: 30`; per-replica `ConfigMap` (port-range slices — `runtimes[]` not env-overridable); `Secret` for `apiKeys` |
| `StorageClass` (any RWO) + per-conversation `PVC` | Migration unit; dynamic provisioning; deleted only on explicit conversation DELETE |
| `ServiceAccount` + namespaced `Role/Binding` | Operator + orchestrator manage Pods/PVCs/CRDs in `ao-instances` |
| Instance `Pod` per conversation | Mounts PVC at `/data/conversations/<id>`; labels for discovery |
| Redis (`StatefulSet` or managed) + `Service` + `Secret` | Leases, owner heartbeats, event Streams/Pub-Sub, global counting |
| `ServiceMonitor`, `PodDisruptionBudget` (≥2 available), optional `NetworkPolicy` | Observability + rollout safety; `HPA` later (needs global counting) |

```text
k8s/
├── namespace.yaml
├── orchestrator/   # deployment, service, ingress, configmap, secret, serviceaccount
├── state/          # redis-statefulset, redis-service, redis-secret
├── observability/  # servicemonitor
└── config/crd/     # opencodeinstances + conversationroutes + rbac
```

## 11. Build phases (shippable slices)

| Phase | Deliverable | Verifies |
|---|---|---|
| A. Detection | `LLM_QUOTA_EXHAUSTED`/`RATE_LIMITED` codes + classifier + metric + event | Unit: 429/402/403 bodies → typed errors; other 500s untouched |
| B. Session persistence | `sessionStorage` config, dual-path layout in all runtimes, durable `sessionId`, mount-verification | E2E: stop on A → resume same `sid` on B |
| C. Volume lifecycle | C1: CRD manifests (`k8s/crd/`) + per-conversation PVC/Pod templates + retention rules. C2 spike PASSED 2026-09-30 on k3d (`ao-test`: k3s v1.31.5, 1 server + 2 agents, host-shared volume): CRD schemas enforced by apiserver (invalid enum rejected), hostPath PV/PVC bound, Pod A (agent-0) wrote workspace+session data, Pod B (agent-1) remounted and verified all files. GC/retention enforcement deferred to operator (Phase E) | C1: manifests parse + schemas match §6–§7 ✅; C2: cross-node remount ✅ (single-writer RWO detach→attach proven via hostPath-over-shared-dir stand-in; dynamic provisioning untested) |
| D. Status reporting | `OpencodeInstance` create/patch on lifecycle + quota events; flap guard | Tokens killed on A → `QuotaExhausted` within budget |
| E. Operator + migration | E1 DONE: controller scaffolding — poll reconcile, route lifecycle (create/delete), dry-run planner (`aor operator`, `k8s/operator/` RBAC+Deployment); live-verified on k3d. E2a DONE: `KubernetesRuntime` (Pod+Service per instance, PVC mounts, node targeting, authenticated probes; live-verified with real opencode image). E2b TODO: execution — operator trigger channel + live migration demo | Quota on A → conversation continues on B, history intact |
| F. Refill + hardening | `QuotaPolicy`, probe-to-clear, selection scoring, metrics (`migrations_total{result}`, `quota_exhaustions_total{model}`), chaos tests | Failover + rollback paths green in CI |

## 12. Known risks

- **K8s client (verified 2026-10-01):** `@kubernetes/client-node` v2 rewrote the API
  (request-builder flavor, deep imports). Pinned `^1.4.0` with the `PromiseCustomObjectsApi`
  flavor via `KubeConfig.makeApiClient` chain. The generated client hardcodes
  `application/json-patch+json` for patch calls (no per-call override) — status/spec
  writes use GET + PUT-replace instead, with `resourceVersion` optimistic concurrency
  (409 → warn, next event retries).
- **Cluster venue (verified 2026-09-30):** k3s v1.35+ requires cgroup v2 and refuses to boot
  on Docker Desktop WSL2 here (cgroup v1, kernel 5.15) — `kubelet ... cgroup v1 ...
  unsupported`. Pin k3d to `rancher/k3s:v1.31.5-k3s1` until the host moves to cgroup v2.
  `k3d-ao-test` cluster (1 server + 2 agents, `/shared` host volume on all nodes) left
  running for Phases D–F.
- **RWO detach/attach latency** (30–120s across nodes on some provisioners): show
  `Migrating…` progress events; serve reads from A while alive, else honest `503`.
- **Absolute-path coupling:** identical mount path on all machines is a hard constraint;
  validate `worktree` row on mount, refuse on mismatch.
- **Version pinning:** DB schema drifts between opencode versions; reject
  version-mismatched targets at placement via `runtimes[].config.version`.
- **Secrets in shared stores:** `baseUrl` credentials + `sessionId` encrypted at rest.
- **Pre-existing:** SSE gauge zeroing bug (`sse-client.ts:159-167`) must be fixed before
  per-Pod metrics are trusted; `ensureReady()` duplicated ×2 must be unified first.
