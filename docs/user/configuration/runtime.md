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
    "networkMode": "host"
  }
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `image` | string | Yes | — | Docker image name (e.g., `ghcr.io/anomalyco/opencode:1.17.8`). |
| `instanceHost` | string | No | `'127.0.0.1'` | Hostname for reaching the instance. |
| `networkMode` | string | No | — | Docker network mode. |

**Use when:** OpenCode CLI is not installed locally, or you need isolation.

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
