# Modules Reference

This page records current ownership boundaries. It intentionally focuses on
stable responsibilities and contracts instead of duplicating every private
method, which remains discoverable in the colocated TypeScript tests.

## Composition and Entry Points

| Module | Responsibility |
|--------|----------------|
| `src/index.ts` | Starts server or operator mode, initializes logging, composes dependencies, and coordinates bounded shutdown. |
| `src/cli.ts` | Defines the Commander command tree, strict parsing, legacy no-command server startup, and exit-code mapping. |
| `src/bootstrap/runtime-environment.ts` | Registers Direct, Docker, and Kubernetes constructors; validates runtime-specific config; creates the shared registry and manager. |
| `src/bootstrap/application-services.ts` | Creates storage, conversation state, lifecycle services, SSE bridge, role service, and cluster reporter. |
| `src/bootstrap/cleanup.ts` | Selects file-log, local persistent-data, and Kubernetes PVC cleanup providers. |

Short-lived client commands do not initialize the server's rotating file sink.
The server and standalone operator initialize it before operational logging and
flush it during graceful or fatal shutdown.

## CLI Modules

| Module | Responsibility |
|--------|----------------|
| `src/cli/api-client.ts` | Bearer authentication, URL encoding, timeouts, JSON decoding, and structured AO API errors. |
| `src/cli/operational.ts` | Status, metrics, conversation, session, message, cleanup, config, and runtime commands. |
| `src/cli/output.ts` | Concise human output and uncontaminated stable JSON output. |
| `src/cli/k8s-command.ts` | Kubernetes option and command registration. |
| `src/cli/k8s-renderer.ts` | Loads packaged YAML, applies typed installation options, labels ownership, and emits deterministic documents. |
| `src/cli/k8s-manager.ts` | Ownership checks, server-side apply, rollout waits, status, doctor, adoption, uninstall, and guarded purge. |

The Kubernetes manager owns AO resources only. It does not manage clusters,
nodes, storage classes, ingress controllers, cert-manager, or monitoring
operators.

## HTTP and WebSocket Transport

| Module | Responsibility |
|--------|----------------|
| `src/http-api/server.ts` | Thin Express composition root for middleware, resource routes, dashboard, and WebSocket upgrade handling. |
| `src/http-api/auth.ts` | API-key normalization, authentication, and explicit method/path-to-permission mapping. |
| `src/http-api/middleware.ts` | Body parsing, security headers, CORS, metrics, request tracking, and final error handling. |
| `src/http-api/request-tracker.ts` | Tracks in-flight HTTP work so shutdown can drain or abort it within the configured timeout. |
| `src/http-api/routes/*.ts` | Resource-focused controllers that validate protocol input and delegate to services. |
| `src/http-api/openapi.ts` | OpenAPI 3.0.3 contract; tests require every registered REST operation to be documented. |
| `src/http-api/websocket-server.ts` | Creates the WebSocket server and binds upgrade lifecycle. |
| `src/websocket/connection.ts` | JSON-RPC framing, heartbeat, idle timeout, responses, and event delivery. |
| `src/websocket/router.ts` | One active connection per conversation, replacement safety, authentication, permission checks, and event subscriptions. |
| `src/websocket/method-dispatcher.ts` | Dispatches authorized RPC methods to the same application services used by REST. |

Transport modules do not implement lifecycle, persistence, or cleanup policy.
Unknown or unmapped authenticated routes fail closed under RBAC.

## Application Services

| Service | Responsibility |
|---------|----------------|
| `ConversationService` | Serializes lifecycle mutations per conversation; create, start, stop, restart, migrate, delete, session adoption, and status reporting. |
| `SessionService` | Proxies OpenCode session operations after enforcing a ready running instance. |
| `MessageService` | Sends prompts, parses provider/model identifiers, retrieves history, updates activity, and reports quota errors. |
| `ConfigService` | Reads, atomically replaces, and deep-patches conversation OpenCode configuration. |
| `AgentService` | Manages agent Markdown and `AGENTS.md`, including restart requirements and runtime views. |
| `FileService` | Workspace file read/write/list/copy/delete operations through the storage boundary. |
| `SkillService` | Transactional skill-tree upload/import/read/delete for conversation or agent scope. |
| `RoleService` | Built-in and custom role lookup, permission resolution, immutable built-ins, and atomic custom-role persistence. |

`ConversationService.withLifecycleLock()` is also used by retention cleanup so a
final orphan check and deletion cannot race a new conversation generation.

## Lifecycle and Workspace Domain

| Module | Responsibility |
|--------|----------------|
| `src/orchestrator/conversation-state.ts` | In-memory lifecycle source of truth, bounded event replay, running-client association, and readiness probes. |
| `src/orchestrator/instance-manager.ts` | Capacity reservation, LRU eviction, idle sweep, workspace reuse, and runtime lifecycle delegation. |
| `src/orchestrator/workspace-factory.ts` | Workspace creation, quota accounting, canonical config enforcement, safe path resolution, and file/agent/skill storage operations. |
| `src/orchestrator/port-pool.ts` | Fixed-range allocation with optional OS-assigned fallback and idempotent release. |
| `src/orchestrator/sse-bridge.ts` | One OpenCode SSE client per active conversation, reconnect policy, filtering, and event forwarding. |

Conversation statuses are `prepared`, `starting`, `running`, `restarting`,
`stopped`, `destroyed`, and `error`. Stop, idle eviction, process exit, and
migration preserve the workspace and managed session data. Explicit deletion
owns workspace and managed persistent-data removal.

## Runtime Abstraction

`src/agent-runtime/types.ts` defines the common contract:

```typescript
interface AgentRuntime {
  readonly type: string;
  readonly capabilities: AgentCapabilities;
  start(id, workspacePath, auth, healthCheck, runtimeAccess?): Promise<AgentEndpoint>;
  stop(handle?, signal?): Promise<void>;
  restart(id, healthCheck): Promise<AgentEndpoint>;
  cleanupOrphans?(): Promise<void>;
  preparePersistentDataDeletion?(id): Promise<void>;
  deletePersistentData?(id): Promise<void>;
}
```

| Module | Responsibility |
|--------|----------------|
| `registry.ts` | Maps configured runtime IDs to valid adapters or retained validation errors. |
| `runtime-factory.ts` | Maps runtime types to constructors and type-specific validators. |
| `runtime-manager.ts` | Owns active endpoints/handles, generation-safe exit callbacks, ports, activity timestamps, and persistent-data hooks. |
| `health.ts` | Bounded authenticated OpenCode health polling. |
| `session-storage.ts` | Versioned ownership records, delete-pending state, quarantine, generation safety, and container mount/env mapping. |
| `runtimes/direct.ts` | Spawns and terminates an OpenCode process tree. |
| `runtimes/docker.ts` | Runs named OpenCode containers with port/network, log-limit, identity, and session mounts. |
| `runtimes/kubernetes.ts` | Creates and verifies per-conversation PVC, Pod, and Service resources with UID/ownership safety. |

An `AgentEndpoint` returns a typed `AgentClient`, optional port/process handle,
base URL, Kubernetes node identity, and persistent-data annotations.

## Storage and Cleanup

| Module | Responsibility |
|--------|----------------|
| `src/storage/types.ts` | Async storage and runtime-access contracts. |
| `src/storage/local.ts` | Local workspace backend with safe deletion and recursive copy. |
| `src/storage/path-safety.ts` | Canonical containment, symlink rejection, and approved copy-source validation. |
| `src/storage/atomic-file.ts` | Permission-preserving atomic file replacement. |
| `src/storage/atomic-directory.ts` | Stage-and-swap directory replacement with rollback. |
| `src/cleanup/cleanup-manager.ts` | Startup/scheduled/manual coordination, preview, single-flight gating, aggregation, metrics, and shutdown. |
| `src/cleanup/file-log-provider.ts` | Prunes only recognized rotated AO log files under configured retention/count rules. |
| `src/cleanup/local-persistent-data-provider.ts` | Enrolls and reaps owned Direct/Docker session artifacts after the two-pass grace policy. |
| `src/cleanup/kubernetes-persistent-data-provider.ts` | Marks and reaps owned PVCs after authority, liveness, Pod-reference, UID, and grace checks. |

Preview is read-only. Executing runs rescan and revalidate immediately before
mutation. Absolute paths, credentials, and file contents are excluded from
reports and logs.

## Kubernetes Cluster Components

| Module | Responsibility |
|--------|----------------|
| `src/cluster/status-reporter.ts` | Writes lifecycle, endpoint, node, quota, and persistent-data ownership to `OpencodeInstance` resources. |
| `src/cluster/operator/controller.ts` | Reconciles instances/routes, evaluates placement, and drives dry-run or execute mode. |
| `src/cluster/operator/placement.ts` | Load- and quota-aware candidate/node scoring. |
| `src/cluster/operator/executor.ts` | Calls AO migration APIs and records bounded migration results. |
| `src/cluster/operator/metrics-server.ts` | Exposes operator-specific Prometheus metrics. |

The placement controller removes stale routes when an instance disappears but
does not eagerly delete its PVC. Persistent-data retention belongs to the
cleanup policy.

## Observability and Utilities

| Module | Responsibility |
|--------|----------------|
| `src/metrics/registry.ts` | 26 bounded AO metrics plus default Node.js/process metrics. |
| `src/utils/logger.ts` | Structured level filtering and shared root/child backend. |
| `src/utils/rolling-file-sink.ts` | Serialized JSONL writes, rotation, pruning, reopen, flush, and close. |
| `src/utils/errors.ts` | Stable application error codes and HTTP status mapping. |
| `src/utils/conversation-id.ts` | Canonical conversation ID validation. |
| `src/opencode-http/client.ts` | Authenticated typed OpenCode REST client. |
| `src/opencode-http/sse-client.ts` | OpenCode SSE parsing and reconnect-aware stream client. |

For deployment behavior, see the [architecture overview](README.md). For exact
public contracts, use the generated `/api-docs` UI or `/api-docs.json` document.
