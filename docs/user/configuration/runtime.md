# Runtime Configuration

Runtime entries define how OpenCode instances are spawned. Each entry has an `id`, `type`, and `config`.

## Runtime Types

### Direct Runtime

Spawns OpenCode as a child process on the host machine.

```jsonc
{
  "id": "opencode-direct",
  "type": "direct",
  "config": {
    "binary": "opencode",
    "version": "1.17.8",
    "instanceHost": "127.0.0.1"
  }
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `binary` | string | Yes | — | OpenCode CLI command or absolute path. |
| `version` | string | No | — | Version hint (e.g., `"1.17.8"`). |
| `instanceHost` | string | No | `'127.0.0.1'` | Hostname for reaching the instance. |
| `sessionStorage` | object | No | — | Managed per-conversation storage: `{ sharedRoot, mode?: "xdg" | "sqlite" }`. Required for Direct persistent-data cleanup. |

**Use when:** OpenCode CLI is installed on the host machine.

### Docker Runtime

Spawns OpenCode in a Docker container.

```jsonc
{
  "id": "opencode-docker",
  "type": "docker",
  "config": {
    "image": "ghcr.io/anomalyco/opencode:1.17.8",
    "instanceHost": "127.0.0.1",
    "networkMode": "host",
    "containerUser": "1000:1000",
    "containerHome": "/tmp/agentorchestrator-home",
    "sessionStorage": { "sharedRoot": "./sessions", "mode": "xdg" },
    "logging": { "driver": "local", "maxSize": "10m", "maxFiles": 3 }
  }
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `image` | string | Yes | — | Docker image name (e.g., `ghcr.io/anomalyco/opencode:1.17.8`). |
| `instanceHost` | string | No | `'127.0.0.1'` | Hostname for reaching the instance. |
| `networkMode` | string | No | — | Docker network mode. |
| `containerUser` | string | No | Image default | Docker user or `uid:gid`. On Linux, match the AO host user when bind-mounted workspaces must remain host-writable. |
| `containerHome` | string | No | `/tmp/agentorchestrator-home` with `containerUser` | Absolute writable HOME inside the container. |
| `sessionStorage` | object | No | — | Managed per-conversation storage mounted in the container. Required for Docker persistent-data cleanup. |
| `logging.driver` | `local` or `json-file` | No | Docker default | Engine log driver for spawned OpenCode containers. |
| `logging.maxSize` | string | No | — | Per-file Docker log size, such as `10m`. |
| `logging.maxFiles` | integer | No | — | Number of Docker log files retained. |

**Use when:** OpenCode CLI is not installed locally, or you need isolation.

`logging` above limits container stdout/stderr and is independent from AO's own
rotating JSONL file logs. See [Logging and Cleanup Policy](cleanup.md).

When AO and Docker run on the same Linux host, set `containerUser` to the uid
and gid of the AO process (for example, `1000:1000`). This prevents the OpenCode
container from leaving root-owned files that AO cannot remove during explicit
conversation deletion. The configured `containerHome` must be writable by that
identity; the default under `/tmp` works with the bundled OpenCode image.

## Network Modes

| Mode | Description | Port Mapping |
|------|-------------|--------------|
| `host` | Container shares host network stack | Skipped |
| `bridge` | Container has its own network (Docker default) | Port mapping required |
| Custom | Named Docker network | Port mapping required |

### Host Mode

```jsonc
{
  "networkMode": "host"
}
```

- Container uses host networking directly
- No port mapping needed
- Instance is reachable at `127.0.0.1:{allocated-port}`
- Best performance, but less isolation

### Bridge Mode

```jsonc
{
  "networkMode": "bridge"
}
```

- Container has its own network namespace
- Port mapping: container port → host port
- Better isolation, slight overhead

## Multiple Runtimes

You can configure multiple runtimes and select per conversation:

```jsonc
{
  "orchestrator": {
    "defaultAgentType": "opencode-direct",
    "runtimes": [
      { "id": "opencode-direct", "type": "direct", "config": { "binary": "opencode" } },
      { "id": "opencode-docker", "type": "docker", "config": { "image": "ghcr.io/anomalyco/opencode:1.17.8" } }
    ]
  }
}
```

Specify the runtime when creating a conversation:

```bash
curl -X POST http://localhost:8080/api/conversations \
  -H "Content-Type: application/json" \
  -d '{"agentType": "opencode-docker"}'
```

If `agentType` is not specified, the `defaultAgentType` is used.

## Runtime Selection Guide

| Scenario | Recommended Runtime |
|----------|-------------------|
| Local development | Direct |
| Production (single server) | Direct |
| Production (multi-tenant) | Docker |
| CI/CD pipelines | Docker |
| Isolation required | Docker |
| Performance critical | Direct |
