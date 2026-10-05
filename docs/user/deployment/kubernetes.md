# Kubernetes Deployment

> **Status:** Supported via manifests in `k8s/` (CRDs, operator RBAC, volume templates).
> Verified on k3d (k3s v1.31.5, 1 server + 2 agents).

## Manifest Layout

```
k8s/
├── namespace.yaml                  # ao-instances namespace
├── crd/
│   ├── opencodeinstances.yaml      # OpencodeInstance: per-instance status (phase, quota, endpoint)
│   └── conversationroutes.yaml     # ConversationRoute: conversation → serving instance
├── operator/
│   ├── serviceaccount.yaml         # placement-controller identity
│   ├── role.yaml                   # namespaced rights (CRDs, pods, PVCs)
│   ├── rolebinding.yaml
│   ├── clusterrole.yaml            # nodes get/list/watch (target selection) + binding
│   └── deployment.yaml             # controller, 1 replica (leader election pending)
├── orchestrator/
│   ├── serviceaccount.yaml         # orchestrator identity
│   ├── role.yaml                   # instance Pods/Services, status CRs, PVC ensure
│   ├── rolebinding.yaml
│   ├── secret.yaml                 # agentorchestrator.json (contains API keys — replace placeholders)
│   ├── workspace-pvc.yaml          # orchestrator's own workspace (20Gi, RWO)
│   ├── deployment.yaml             # server, 1 replica (sticky routing required if scaled)
│   ├── service.yaml                # ClusterIP :8080
│   ├── ingress.yaml                # Traefik sticky-cookie ingress (set host + TLS)
│   └── servicemonitor.yaml         # Prometheus scraping (requires prometheus-operator)
└── volume/
    ├── conversation-pvc-template.yaml  # per-conversation RWO PVC (10Gi default)
    └── instance-pod-template.yaml      # instance Pod shape (mounts, probes, fsGroup)
```

## Prerequisites

- Kubernetes 1.31+ cluster. Note: k3s **v1.35+ requires cgroup v2** and refuses to boot
  on hosts with cgroup v1 (e.g. Docker Desktop WSL2); v1.31.5 is verified there.
- Any `ReadWriteOnce`-capable `StorageClass` (default provisioner is fine — each
  volume is mounted by at most one instance Pod at a time, so no RWX filesystem
  is needed).
- An `opencode serve` container image (e.g. `ghcr.io/anomalyco/opencode:latest`).

## Install Order

```bash
kubectl apply -f k8s/namespace.yaml -f k8s/crd/
# Edit the shared Secret first (API keys and cleanup.ownerId), then:
kubectl apply -f k8s/orchestrator/secret.yaml
kubectl apply -f k8s/operator/
kubectl apply -f k8s/orchestrator/
```

## Running the Orchestrator In-Cluster

`k8s/orchestrator/` deploys the API server itself: `Secret`-mounted config
(`agentorchestrator.json` with a `kubernetes` runtime + `cluster.enabled`),
own workspace PVC (`ao-workspace`), `ClusterIP` Service, Traefik sticky ingress
(set `agentorchestrator.example.com` + TLS), and a `ServiceMonitor`.
The placement-controller Deployment mounts that same Secret so both processes
use the identical `cleanup.ownerId`; do not give them separate owner values.
Scale beyond 1 replica only with sticky routing — conversation state is
per-Pod until shared state lands (see limitations).

## Architecture

```
┌──────────────────────────────────────────────────────┐
│ Kubernetes Cluster (namespace: ao-instances)         │
│                                                      │
│  ┌────────────────────┐  ┌────────────────────────┐  │
│  │ Orchestrator       │  │ Placement controller   │  │
│  │ (Deployment, N     │  │ (Deployment, 1 replica │  │
│  │  replicas)         │  │  `aor operator`)       │  │
│  │ kubernetes runtime │  │ watches instances,     │  │
│  │ reports status via │  │ maintains routes,      │  │
│  │ cluster.* config   │  │ executes migrations    │  │
│  └────────┬───────────┘  └────────────────────────┘  │
│           │ spawns                                   │
│  ┌────────▼───────────┐                              │
│  │ Instance Pod +     │  per conversation:           │
│  │ ClusterIP Service  │  PVC `conv-<id>` mounted at  │
│  │  - workspace/      │  `/data/conversations/<id>`  │
│  │  - session/ (DB)   │  (workspace + session tree)   │
│  └────────────────────┘                              │
│  OpencodeInstance + ConversationRoute CRs track      │
│  status (Ready/QuotaExhausted/RateLimited) and routing│
└──────────────────────────────────────────────────────┘
```

## Orchestrator Configuration

Add a `kubernetes` runtime entry (see `config/agentorchestrator.example.json`)
and enable status reporting so the controller can place and migrate:

```jsonc
{
  "orchestrator": {
    "defaultAgentType": "opencode-k8s",
    "runtimes": [
      {
        "id": "opencode-k8s",
        "type": "kubernetes",
        "config": {
          "image": "ghcr.io/anomalyco/opencode:latest",
          "namespace": "ao-instances",
          "sessionMode": "xdg",
          "pvcStorage": "10Gi"
          // "instanceHost": "127.0.0.1", // + kubectl port-forward when orchestrating from outside
          // "nodeName": "worker-2",       // pin scheduling (migration target)
        }
      }
    ]
  },
  "cluster": {
    "enabled": true,
    "namespace": "ao-instances",
    "heartbeatIntervalMs": 60000,
    "quotaFailureThreshold": 2
    // "advertiseBaseUrl": "http://orchestrator:8080" // owner URL for migration callbacks
  },
  "cleanup": {
    "ownerId": "production-cluster-1",
    "sweepIntervalMs": 3600000,
    "orphanedData": {
      "enabled": true,
      "gracePeriodMs": 2592000000
    }
  }
}
```

| `cluster.*` field | Default | Purpose |
|-------------------|---------|---------|
| `enabled` | `false` | Report lifecycle/quota status to `OpencodeInstance` CRs |
| `namespace` | `'ao-instances'` | Namespace for status objects |
| `heartbeatIntervalMs` | `60000` | Status heartbeat (`0` = disable) |
| `quotaFailureThreshold` | `2` | Consecutive quota errors before `QuotaExhausted` |
| `advertiseBaseUrl` | server host:port | Owner URL the controller calls back (`POST /:id/migrate`) |

## Per-Conversation Volumes

One RWO PVC per conversation (`conv-<id>`, see `k8s/volume/conversation-pvc-template.yaml`).
The instance Pod mounts it at `/data/conversations/<id>` (`workspace/` + `session/`).
The runtime ensures the claim exists before creating the Pod; the controller performs
the same operation idempotently while reconciling status objects. Managed claims carry
owner, artifact, state, and timestamp annotations.

An explicit conversation `DELETE` marks the PVC delete-pending, waits until no Pod
references it, mirrors the marker to the corresponding `OpencodeInstance`, and
deletes with a UID precondition. The controller treats delete-pending instance
records as tombstones: it removes their routes, never recreates storage, and removes
the record after the PVC is gone. Missing instance records only remove stale routes.
Periodic orphan cleanup requires healthy CR/route/Pod/PVC
listings, a matching stable `cleanup.ownerId`, two observations separated by the full
grace period, and a fresh UID/ownership check. Stopped, restarted, migrated, and
idle-evicted conversations retain their PVCs. Foreign or unlabeled PVCs are never
touched.

## Placement Controller

Runs `aor operator` (image `luberserker/agent-orchestrator:main` or a release tag):

| Flag | Default | Purpose |
|------|---------|---------|
| `--namespace` | `ao-instances` | Watched namespace |
| `--interval-ms` | `15000` | Reconcile interval |
| `--execute` | off (dry-run) | Perform migrations (log-only otherwise) |
| `--api-key` | — | Bearer token for migrate calls |
| `--migrate-timeout-ms` | `300000` | Migrate call timeout |
| `--refill-window-ms` | `86400000` | Quota refill window |
| `--model-refill-window` | — | Per-model override (`provider/model=ms`, repeatable) |
| `--metrics-port` | `0` (disabled) | Prometheus scrape endpoint |
| `--pvc-storage` | `10Gi` | Storage request for auto-provisioned per-conversation PVCs |

The controller ensures `conv-<id>` PVCs exist when instances appear
(dynamic provisioning via the default `StorageClass`). When an instance object
disappears, the controller removes only its stale route; the cleanup policy owns PVC
retention and deletion.

Kubernetes container logs remain owned by the kubelet/container runtime. Configure
node log rotation and a TTL in the external log backend independently from AO's
optional JSONL file sink. PVC requested capacity is not reported as reclaimed bytes,
because it is not a reliable measure of bytes actually reclaimed.

Quota flow: LLM 429/402/403 → typed `LLM_QUOTA_EXHAUSTED` → instance flips to
`QuotaExhausted` after the flap threshold → controller migrates the Pod to a healthy
node and resumes the same session → elapsed windows flip back to `Ready` (refill).

## Health Probes

| Probe | Path | Port | Initial Delay | Period |
|-------|------|------|---------------|--------|
| Liveness | `/global/health` | instance port | 10s | 30s |
| Readiness | `/global/health` | instance port | 5s | 10s |

Instance probes authenticate with Basic auth (the server requires it) — see
`KubernetesRuntime` and `k8s/volume/instance-pod-template.yaml`.

## Current Limitations

- Single replica controller (leader election pending) — run exactly 1.
- Route-aware request routing across multiple orchestrators is not built yet;
  quota migration currently executes within one orchestrator.
- No shared conversation state (Redis) yet — orchestrator restarts lose
  in-memory records (PVC data persists).

## Kubernetes E2E Test

### Existing Cluster Lifecycle Suite

With the manifests deployed and the current image imported into the `ao-test`
k3d cluster, run:

```bash
npm run test:e2e:kubernetes
```

Override `K8S_E2E_CONTEXT` or `K8S_E2E_NAMESPACE` when using another cluster.
The suite creates uniquely named conversations and verifies PVC provisioning,
readiness, status/route reconciliation, stop/restart session persistence,
same-node migration, serialized start/delete behavior, deletion garbage
collection, and failed-start cleanup. It does not require an LLM provider
credential. The host's current kubeconfig context must match
`K8S_E2E_CONTEXT` because one rollback scenario instantiates the Kubernetes
runtime directly.

### Isolated Cross-Node Migration Suite

To exercise execute-mode placement and migration without preparing or changing
an existing cluster, run:

```bash
npm run test:e2e:k3d
```

Docker, k3d, and kubectl must be installed and available on `PATH`. The runner
creates a disposable cluster with one server and two worker nodes, builds and
imports the current AgentOrchestrator and OpenCode images, generates its own API
key, and uses an isolated kubeconfig without switching the host's current
context.

A dedicated Docker volume is mounted at `/shared` on every k3d node. Static
host-path PVs backed by that volume let the suite verify that one RWO PVC retains
the workspace and session data while its instance Pod moves between workers.
The suite covers successful migration and session resume, route/history/event
convergence with no duplicate migration, failed placement on a synthetic node,
PVC retention and retry quarantine, and manual recovery on a healthy worker.

Resources are removed after the run. Set `K3D_E2E_REPEAT` to a positive integer
for a repeated soak run, or set `K3D_E2E_KEEP=1` to keep the generated cluster,
shared volume, images, and temporary files for diagnosis:

```bash
K3D_E2E_REPEAT=10 npm run test:e2e:k3d
K3D_E2E_KEEP=1 npm run test:e2e:k3d
```

## Alternatives

For single-host setups, see [Docker Deployment](docker.md) and [npm Deployment](npm.md).
