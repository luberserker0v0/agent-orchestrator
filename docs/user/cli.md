# `aor` Command Reference

`aor` starts AgentOrchestrator, operates a running server, and manages the
AgentOrchestrator components installed in Kubernetes.

## Server and Client Options

Running `aor` without a subcommand remains equivalent to `aor serve`.

```bash
aor serve --config ./config/agentorchestrator.json --host 0.0.0.0 --port 8080
```

Operational commands accept these global options:

| Option | Environment fallback | Default |
|--------|----------------------|---------|
| `--server <url>` | `AOR_SERVER_URL` | `http://127.0.0.1:8080` |
| `--api-key-file <path>` | `AOR_API_KEY` | unauthenticated |
| `--timeout <ms>` | — | `30000` |
| `--json` | — | human-readable tables |

The key file takes precedence over `AOR_API_KEY`. Prefer either mechanism over
putting a key directly in command arguments. JSON output is written alone to
stdout; diagnostics are written to stderr.

## Operational Commands

```text
aor status
aor metrics
aor dashboard

aor conversation list|get|create|start|stop|restart|events|migrate|delete
aor session list|get|create|fork|messages|abort|delete
aor message send
aor cleanup preview|run
aor config validate
aor runtime list|info
```

Examples:

```bash
aor --json status
aor conversation create demo --agent-type opencode-docker --start
aor message send demo --text "Summarize this repository"
aor session list demo
aor cleanup preview --target logs --target persistentData
aor cleanup run --target logs --confirm
aor conversation delete demo --confirm
```

Conversation and session deletion and cleanup execution require `--confirm`.
Cleanup reports with `partial` or `failed` status return a non-zero exit code.

Exit codes are stable for automation:

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Runtime failure or partial cleanup |
| `2` | Invalid command or input |
| `3` | Authentication or authorization failure |
| `4` | Resource not found |
| `5` | Conflict or operation already in progress |

## Kubernetes Commands

Use the Kubernetes-specific example as a starting point and replace its example
API key before installation:

```bash
cp config/agentorchestrator.k8s.example.json ao-k8s.json
aor k8s render --config-file ao-k8s.json > rendered.yaml
aor k8s install --config-file ao-k8s.json
aor k8s status
aor k8s doctor
```

The default install deploys the orchestrator and placement operator. Migration
execution remains disabled. Ingress and ServiceMonitor are opt-in:

```bash
aor k8s install \
  --config-file ao-k8s.json \
  --namespace ao-instances \
  --ingress-host ao.example.com \
  --tls-secret ao-tls \
  --service-monitor
```

An externally managed Secret can be used instead of a local config file:

```bash
aor k8s install --existing-config-secret agent-orchestrator-config
```

It must contain the key `agentorchestrator.json`. The CLI verifies the content
but never adopts, updates, prints, or deletes the external Secret.

`install` and `upgrade` use server-side apply and refuse same-name resources
that lack the matching installation identity. Compatible resources from the
legacy manifests can be explicitly adopted:

```bash
aor k8s adopt --config-file ao-k8s.json --confirm
aor k8s install --config-file ao-k8s.json
```

Normal uninstall preserves configuration, CRDs, custom-resource state, and all
PVCs so the installation can be recovered:

```bash
aor k8s uninstall --confirm
```

Data purge is separate and deletes only resources whose installation and cleanup
ownership can be revalidated. If any owned claim is still referenced by a Pod,
the purge stops before deleting anything; run normal uninstall and wait for its
Pods to terminate first. Foreign resources are preserved:

```bash
aor k8s uninstall --purge-data --confirm
```

Common Kubernetes options include `--kubeconfig`, `--context`, `--namespace`,
`--installation`, `--image`, `--workspace-size`, `--conversation-storage`, and
`--storage-class`. Use exactly one of `--config-file` or
`--existing-config-secret` for initial install. `--no-operator` disables the
placement controller. Execute mode requires both `--operator-execute` and
`--operator-api-key-secret <name:key>`. Ingress (`--ingress-host`,
`--ingress-class`, `--tls-secret`) and `--service-monitor` remain opt-in.

`aor operator --api-key` remains supported for compatibility. For a Deployment,
prefer `AOR_OPERATOR_API_KEY` populated from a Kubernetes Secret; the renderer
uses this mechanism for `--operator-execute`.

The CLI manages AgentOrchestrator resources only. It does not install or modify
Kubernetes nodes, k3d, storage classes, ingress controllers, cert-manager, or the
Prometheus Operator.
