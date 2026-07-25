# Orchestrator Configuration

The `orchestrator` section controls instance lifecycle, runtime selection, health checks, and SSE event forwarding.

## Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxInstances` | integer | `10` | Maximum concurrent OpenCode instances. |
| `idleTimeoutMs` | integer | `600000` | Time (ms) before an unused instance is auto-destroyed. `0` = disabled. |
| `idleSweepIntervalMs` | integer | `60000` | How often (ms) the background sweep checks for idle instances. |
| `portRange` | object | `{ start: 30000, end: 30100 }` | Port range for dynamic allocation. |
| `defaultAgentType` | string | `'opencode-direct'` | Default agent type. Must match a `runtimes[].id`. |
| `runtimes` | array | See below | Runtime configurations. |
| `healthCheck` | object | See below | Health check settings. |
| `sse` | object | See below | SSE event forwarding settings. |

## Port Range

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `start` | integer | `30000` | First port in the allocation range. |
| `end` | integer | `30100` | Last port in the allocation range. |
| `allowDynamicFallback` | boolean | `true` | Allow dynamic port fallback if range is exhausted. |

**Validation:** `maxInstances` must not exceed `portRange.end - portRange.start + 1`.

## Runtimes

Each runtime entry defines how to spawn OpenCode instances.

### Direct Runtime

Spawns OpenCode as a child process.

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

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `binary` | string | Yes | OpenCode CLI command or absolute path. |
| `version` | string | No | Version hint for compatibility. |
| `instanceHost` | string | No | Hostname for reaching the instance. Default: `127.0.0.1`. |

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

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `image` | string | Yes | Docker image name. |
| `instanceHost` | string | No | Hostname for reaching the instance. Default: `127.0.0.1`. |
| `networkMode` | string | No | Docker network mode (`host`, `bridge`, or custom). When `host`, port mapping is skipped. |

### Default Runtimes

```jsonc
{
  "runtimes": [
    { "id": "opencode-direct", "type": "direct", "config": { "binary": "opencode", "version": "1.17.8" } },
    { "id": "opencode-docker", "type": "docker", "config": { "image": "ghcr.io/anomalyco/opencode:1.17.8" } }
  ]
}
```

## Health Check

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `retries` | integer | `10` | Number of health check attempts before giving up. |
| `intervalMs` | integer | `500` | Delay (ms) between retries. |
| `clientTimeoutMs` | integer | `5000` | HTTP client timeout per health check request. |

## SSE (Server-Sent Events)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable SSE event forwarding from OpenCode instances. |
| `reconnectMaxAttempts` | integer | `10` | Max reconnect attempts before giving up. |
| `reconnectBaseMs` | integer | `1000` | Base delay (ms) for exponential backoff. |
| `filterHeartbeat` | boolean | `true` | Filter heartbeat events to reduce noise. |

## WebSocket

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `heartbeatIntervalMs` | integer | `30000` | Heartbeat interval (ms) for WebSocket connections. |
| `idleTimeoutMs` | integer | `600000` | Idle timeout (ms) for WebSocket connections. |

## Environment Variables

| Variable | Overrides |
|----------|-----------|
| `AGENTORCHESTRATOR_ORCHESTRATOR_MAX_INSTANCES` | `orchestrator.maxInstances` |
| `AGENTORCHESTRATOR_ORCHESTRATOR_IDLE_TIMEOUT_MS` | `orchestrator.idleTimeoutMs` |
| `AGENTORCHESTRATOR_ORCHESTRATOR_IDLE_SWEEP_INTERVAL_MS` | `orchestrator.idleSweepIntervalMs` |
