# Kubernetes Setup

This setup installs AgentOrchestrator, its CRDs and RBAC, a workspace PVC, and
the placement operator. Each started conversation gets an OpenCode Pod, Service,
and persistent PVC. The `aor k8s` manager renders and applies only resources
owned by the selected installation identity.

## 1. Prerequisites

- Node.js 24 or newer and npm 10 or newer on the administration host.
- Kubernetes 1.31 or newer and a working `kubectl` context.
- A default `ReadWriteOnce`-capable StorageClass, or its name for
  `--storage-class`.
- Permission to create CRDs, cluster-scoped RBAC, a namespace, Deployments,
  Services, Secrets, and PVCs.
- Cluster nodes able to pull `luberserker/agent-orchestrator` and
  `ghcr.io/anomalyco/opencode` images.

Install the management CLI and inspect the target cluster before changing it:

```bash
npm install -g @luberserker0v0/agent-orchestrator
aor --version
kubectl config current-context
kubectl cluster-info
kubectl get storageclass
```

For a disposable local cluster, k3d is supported. Create one only when you do
not already have a target cluster:

```bash
k3d cluster create ao-demo --servers 1 --agents 2
kubectl config use-context k3d-ao-demo
```

The installer does not create clusters, nodes, StorageClasses, ingress
controllers, cert-manager, or monitoring operators.

## 2. Create and validate the configuration

Copy the packaged example from this repository, or create `ao-k8s.json` with the
following content. Replace the API key and choose a unique, stable owner ID:

```json
{
  "server": {
    "port": 8080,
    "host": "0.0.0.0",
    "apiKeys": [
      {
        "key": "REPLACE_WITH_A_LONG_RANDOM_KEY",
        "role": "admin",
        "name": "cluster-admin"
      }
    ],
    "rbac": { "enabled": true }
  },
  "cleanup": {
    "ownerId": "ao-cluster-1",
    "sweepIntervalMs": 3600000,
    "orphanedData": {
      "enabled": false,
      "gracePeriodMs": 2592000000
    }
  },
  "orchestrator": {
    "maxInstances": 10,
    "defaultAgentType": "opencode-k8s",
    "runtimes": [
      {
        "id": "opencode-k8s",
        "type": "kubernetes",
        "config": {
          "image": "ghcr.io/anomalyco/opencode:1.17.8",
          "namespace": "ao-instances",
          "sessionMode": "xdg",
          "pvcStorage": "10Gi",
          "podReadyTimeoutMs": 180000
        }
      }
    ]
  },
  "workspace": {
    "basePath": "/data/workspace",
    "enforceCanonicalConfig": true,
    "maxSizeBytes": 52428800,
    "storage": { "type": "local" }
  },
  "cluster": {
    "enabled": true,
    "namespace": "ao-instances",
    "heartbeatIntervalMs": 60000,
    "quotaFailureThreshold": 2,
    "advertiseBaseUrl": "http://agent-orchestrator.ao-instances.svc.cluster.local:8080"
  }
}
```

Save the same raw admin key in `ao-admin.key`. Restrict both files on POSIX
systems and keep them out of source control:

```bash
chmod 600 ao-k8s.json ao-admin.key
aor config validate ./ao-k8s.json
```

The config file becomes an owned Kubernetes Secret. Use
`--existing-config-secret` instead when a separate secret manager owns the
Secret; it must contain an `agentorchestrator.json` key.

## 3. Render, review, and install

Pin the AO image to the same release as the CLI. Rendered YAML contains the
configuration Secret and must be handled as a credential-bearing file:

```bash
aor k8s render \
  --config-file ./ao-k8s.json \
  --image luberserker/agent-orchestrator:1.2.2 \
  --namespace ao-instances \
  --installation agent-orchestrator \
  --output ./rendered.yaml
```

Review resource kinds, namespaces, storage requests, images, and ownership
labels locally. Do not commit or paste `rendered.yaml` into logs. Then install:

```bash
aor k8s install \
  --config-file ./ao-k8s.json \
  --image luberserker/agent-orchestrator:1.2.2 \
  --namespace ao-instances \
  --installation agent-orchestrator
```

The default operator is installed in migration dry-run mode. Enable execution
only after creating a Secret containing an admin key and passing
`--operator-execute --operator-api-key-secret <secret>:<key>`.

Wait for and inspect the installation:

```bash
kubectl rollout status deployment/agent-orchestrator -n ao-instances --timeout=5m
kubectl rollout status deployment/placement-controller -n ao-instances --timeout=5m
aor k8s status --namespace ao-instances --installation agent-orchestrator
aor k8s doctor --namespace ao-instances --installation agent-orchestrator
kubectl get pods,services,pvc -n ao-instances
kubectl get crd opencodeinstances.agentorchestrator.io conversationroutes.agentorchestrator.io
```

`doctor` is read-only. Resolve permission, CRD, image, configuration, or storage
diagnostics before creating conversations.

## 4. Connect to the API

For a private smoke test, forward the Service in a dedicated terminal:

```bash
kubectl port-forward -n ao-instances service/agent-orchestrator 8080:8080
```

Keep that terminal open. In another terminal:

```bash
aor --server http://127.0.0.1:8080 --api-key-file ./ao-admin.key status
```

For long-term access, use `--ingress-host`, `--ingress-class`, and optionally
`--tls-secret` during install/upgrade. The referenced ingress controller and TLS
Secret must already exist. Never expose an unauthenticated or plaintext public
endpoint.

## 5. Run the lifecycle and PVC smoke test

Create and start one conversation:

```bash
aor --server http://127.0.0.1:8080 --api-key-file ./ao-admin.key conversation create k8s-smoke --agent-type opencode-k8s --start
aor --server http://127.0.0.1:8080 --api-key-file ./ao-admin.key conversation get k8s-smoke
kubectl get pod,service,pvc -n ao-instances -l agentorchestrator.io/conversation=k8s-smoke
kubectl get opencodeinstance,conversationroute -n ao-instances
```

Repeat `conversation get k8s-smoke` until it reports `ready: true` before
creating the session. The first image pull and PVC attachment can take longer
than later starts.

Create a session, stop the runtime, and verify the PVC remains while the Pod is
gone:

```bash
aor --server http://127.0.0.1:8080 --api-key-file ./ao-admin.key session create k8s-smoke --title "PVC persistence check"
aor --server http://127.0.0.1:8080 --api-key-file ./ao-admin.key conversation stop k8s-smoke
kubectl get pvc conv-k8s-smoke -n ao-instances
kubectl get pod opencode-k8s-smoke -n ao-instances
```

The final Pod command should report `NotFound`; the PVC command must succeed.
Start the conversation again and confirm its session is still visible:

```bash
aor --server http://127.0.0.1:8080 --api-key-file ./ao-admin.key conversation start k8s-smoke
aor --server http://127.0.0.1:8080 --api-key-file ./ao-admin.key session list k8s-smoke
kubectl get pod opencode-k8s-smoke -n ao-instances -o wide
```

Explicit deletion removes the instance objects and the whole managed PVC after
no Pod references it:

```bash
aor --server http://127.0.0.1:8080 --api-key-file ./ao-admin.key conversation delete k8s-smoke --confirm
kubectl wait --for=delete pvc/conv-k8s-smoke -n ao-instances --timeout=2m
kubectl get pod,service,pvc -n ao-instances -l agentorchestrator.io/conversation=k8s-smoke
```

## 6. Optional LLM and migration checks

Provide the LLM credential through your approved Kubernetes Secret/configuration
flow, then use `aor message send` as in the other tutorials. This can consume
provider credits.

To test manual placement on a multi-node cluster:

```bash
kubectl get nodes
aor --server http://127.0.0.1:8080 --api-key-file ./ao-admin.key conversation create migration-smoke --agent-type opencode-k8s --start
aor --server http://127.0.0.1:8080 --api-key-file ./ao-admin.key conversation migrate migration-smoke --node REPLACE_WITH_TARGET_NODE
kubectl get pod opencode-migration-smoke -n ao-instances -o wide
aor --server http://127.0.0.1:8080 --api-key-file ./ao-admin.key conversation delete migration-smoke --confirm
```

## 7. Upgrade and uninstall safely

`upgrade` reuses the recorded installation options. Override only the values
that should change:

```bash
aor k8s upgrade \
  --namespace ao-instances \
  --installation agent-orchestrator \
  --image luberserker/agent-orchestrator:1.2.2
aor k8s status --namespace ao-instances --installation agent-orchestrator
```

Normal uninstall removes owned workloads, Services, ingress/monitoring objects,
and RBAC, but preserves the namespace, CRDs, configuration Secret, custom
resources, workspace PVC, and conversation PVCs:

```bash
aor k8s uninstall --namespace ao-instances --installation agent-orchestrator --confirm
kubectl get pvc,secrets -n ao-instances
```

Reinstall with the same identity and config to recover the preserved platform.
For an intentional final teardown, first ensure no Pods reference owned claims,
review the `status` inventory, and then run the separate destructive operation:

```bash
aor k8s status --namespace ao-instances --installation agent-orchestrator
aor k8s uninstall --namespace ao-instances --installation agent-orchestrator --purge-data --confirm
```

Purge revalidates ownership and Pod references immediately before deletion. It
does not delete external Secrets or foreign/unlabelled resources. If you created
the disposable k3d cluster above, delete it separately after the AO purge:

```bash
k3d cluster delete ao-demo
```

## 8. Troubleshooting

```bash
aor k8s doctor --namespace ao-instances --installation agent-orchestrator --json
kubectl get events -n ao-instances --sort-by=.lastTimestamp
kubectl logs -n ao-instances deployment/agent-orchestrator --tail=200
kubectl logs -n ao-instances deployment/placement-controller --tail=200
kubectl describe pvc -n ao-instances
```

- `Pending` PVC: select a valid StorageClass or fix the cluster provisioner.
- `ImagePullBackOff`: verify node registry access and the exact AO/OpenCode tags.
- Ownership conflict: inspect the named object. Use `aor k8s adopt --confirm`
  only for compatible legacy AO resources; never adopt foreign workloads.
- Purge conflict: stop/delete the Pod referencing the claim, wait for deletion,
  and retry. Do not remove PVC finalizers to bypass the safety check.
- `401`/`403` through the port-forward: verify `ao-admin.key` matches the config
  stored in the owned Secret and that RBAC is enabled as expected.

See the [Kubernetes deployment reference](../deployment/kubernetes.md) for CRD,
operator, cleanup, and k3d E2E internals.
