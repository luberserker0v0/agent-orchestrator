# Configuration Reference

AgentOrchestrator uses a JSONC (JSON with Comments) configuration file. All fields have sensible defaults.

## Config File Locations

The system searches for configuration in this order:

1. `--config <path>` CLI argument
2. `./ao.config.json` (current directory)
3. `./config/agentorchestrator.json` (current directory)
4. `./config/agentorchestrator.example.json` (fallback)

## Environment Variable Overrides

Any config field can be overridden via environment variables:

| Config Path | Environment Variable |
|-------------|---------------------|
| `server.port` | `AGENTORCHESTRATOR_SERVER_PORT` |
| `server.host` | `AGENTORCHESTRATOR_SERVER_HOST` |
| `server.shutdownTimeoutMs` | `AGENTORCHESTRATOR_SERVER_SHUTDOWN_TIMEOUT_MS` |
| `orchestrator.maxInstances` | `AGENTORCHESTRATOR_ORCHESTRATOR_MAX_INSTANCES` |
| `orchestrator.idleTimeoutMs` | `AGENTORCHESTRATOR_ORCHESTRATOR_IDLE_TIMEOUT_MS` |
| `orchestrator.idleSweepIntervalMs` | `AGENTORCHESTRATOR_ORCHESTRATOR_IDLE_SWEEP_INTERVAL_MS` |
| `workspace.maxSizeBytes` | `AGENTORCHESTRATOR_WORKSPACE_MAXSIZEBYTES` |

**Note:** The `orchestrator.runtimes` array is not overridable via env vars. Use the config file for multi-runtime setups.

## Config Sections

| Section | Description | Guide |
|---------|-------------|-------|
| `server` | HTTP server, auth, API keys | [Server Config](server.md) |
| `orchestrator` | Instance lifecycle, runtimes, health checks | [Orchestrator Config](orchestrator.md) |
| `workspace` | File storage, quotas | [Workspace Config](workspace.md) |
| `websocket` | WebSocket connection settings | [Orchestrator Config](orchestrator.md#websocket) |

## Example Config

```jsonc
{
  "server": {
    "port": 8080,
    "host": "127.0.0.1",
    "shutdownTimeoutMs": 15000,
    "apiKeys": [
      { "key": "admin-secret-key-12345678", "role": "admin", "name": "Admin" },
      { "key": "user-secret-key-12345678", "role": "user", "name": "User" },
      { "key": "observer-secret-key-12345678", "role": "observer", "name": "Observer" }
    ]
  },
  "websocket": {
    "heartbeatIntervalMs": 30000,
    "idleTimeoutMs": 600000
  },
  "orchestrator": {
    "maxInstances": 10,
    "idleTimeoutMs": 600000,
    "idleSweepIntervalMs": 60000,
    "portRange": { "start": 30000, "end": 30100 },
    "defaultAgentType": "opencode-direct",
    "runtimes": [
      { "id": "opencode-direct", "type": "direct", "config": { "binary": "opencode" } }
    ],
    "healthCheck": { "retries": 10, "intervalMs": 500, "clientTimeoutMs": 5000 },
    "sse": { "enabled": true, "reconnectMaxAttempts": 10, "reconnectBaseMs": 1000, "filterHeartbeat": true }
  },
  "workspace": {
    "basePath": "./workspace",
    "enforceCanonicalConfig": true,
    "maxSizeBytes": 52428800,
    "storage": { "type": "local" }
  }
}
```
