# Docker Deployment Reference

For a first installation, follow the complete
[Docker container setup](../setup/docker.md). It includes a secure configuration,
Compose file, durable volumes, authenticated lifecycle test, persistence check,
upgrade, teardown, and troubleshooting.

## Images

Use `luberserker/agent-orchestrator:<version>` to run AgentOrchestrator. Do not
use `ghcr.io/anomalyco/opencode` as the AO server image; that image is used by
the optional Docker/Kubernetes runtime to run OpenCode instances.

Release tags are immutable deployment inputs. Pin a version rather than relying
on the moving `main` tag:

```bash
docker pull luberserker/agent-orchestrator:1.2.2
```

## Persistent paths

The published image runs as an unprivileged user and provides these persistent
locations when using the setup tutorial’s configuration:

| Container path | Purpose | Delete behavior |
|----------------|---------|-----------------|
| `/data/workspace` | Conversation workspaces and the tutorial's `.ao-sessions` root | Explicit conversation deletion removes only that conversation's managed data |
| `/data/logs` | Optional rotating AgentOrchestrator JSONL logs | Governed by the configured retention policy |
| `/run/ao/agentorchestrator.json` | Read-only server configuration | Managed outside the image |
| `/run/secrets/ao_admin_key` | Read-only CLI credential | Managed outside the image |

Named volumes survive `docker compose down`. `docker compose down --volumes`
deletes them and must be treated as destructive.

## Logs

Two independent policies apply:

- Compose rotates the container's stdout/stderr using its `logging` block.
- `logging.file` mirrors filtered records to JSONL under `/data/logs`.

```bash
docker compose logs -f agent-orchestrator
docker compose exec -T agent-orchestrator ls -l /data/logs
```

## Runtime choice

The end-to-end container tutorial uses the bundled OpenCode binary through the
`direct` runtime. This does not expose the host Docker API.

Running the AO container with a `docker` runtime requires access to a Docker
daemon, compatible host/container paths, and usually a Docker socket mount. A
socket mount grants container code control over the host daemon. Prefer running
AO directly on the host for the Docker runtime, or use Kubernetes when stronger
isolation and scheduling are required. See the
[runtime reference](../configuration/runtime.md).

## Operations

```bash
# Current state and recent logs
docker compose ps
docker compose logs --tail 100 agent-orchestrator

# Graceful restart
docker compose restart agent-orchestrator

# Upgrade after changing AO_VERSION in .env
docker compose pull
docker compose up -d

# Preserve volumes while removing the workload
docker compose down
```

The server handles `SIGTERM` by stopping timers, closing clients, draining HTTP
requests, stopping active OpenCode processes, and flushing file logs within
`server.shutdownTimeoutMs`.
