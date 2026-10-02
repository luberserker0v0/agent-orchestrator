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
kubectl apply -f k8s/operator/
```

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
          "sessionMode": "xdg"
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
Retention: deleted **only** on explicit conversation DELETE — never on migration,
eviction, or idle timeout.

## Placement Controller

Runs `aor operator` (image `luberserker/agent-orchestrator:latest`):

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

## Alternatives

For single-host setups, see [Docker Deployment](docker.md) and [npm Deployment](npm.md).
