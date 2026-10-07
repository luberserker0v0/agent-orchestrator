# Config Loader Deep Dive

This document explains the internal workings of the configuration loading system.

## Loading Sequence

```
1. Parse CLI args (--config, --port, --host)
         │
2. Search config files (in order):
   ├── --config <path> (CLI argument)
   ├── ./ao.config.json
   ├── ./config/agentorchestrator.json
   └── ./config/agentorchestrator.example.json (fallback)
         │
3. Read JSONC file (supports comments)
         │
4. Apply env var overrides:
   ├── AGENTORCHESTRATOR_SERVER_PORT → server.port
   ├── AGENTORCHESTRATOR_SERVER_HOST → server.host
   ├── AGENTORCHESTRATOR_SERVER_RBAC_ENABLED → server.rbac.enabled
   ├── AGENTORCHESTRATOR_ORCHESTRATOR_MAX_INSTANCES → orchestrator.maxInstances
   ├── AGENTORCHESTRATOR_ORCHESTRATOR_IDLE_TIMEOUT_MS → orchestrator.idleTimeoutMs
   ├── AGENTORCHESTRATOR_ORCHESTRATOR_IDLE_SWEEP_INTERVAL_MS → orchestrator.idleSweepIntervalMs
   ├── AGENTORCHESTRATOR_WORKSPACE_MAX_SIZE_BYTES → workspace.maxSizeBytes
   └── AGENTORCHESTRATOR_CLEANUP_SWEEP_INTERVAL_MS → cleanup.sweepIntervalMs
         │
5. Deep merge with defaults (defaultConfig())
         │
6. Validate all fields
         │
7. Return AgentOrchestratorConfig
```

## Key Functions

### `loadConfig(configPath?)`

Main entry point. Searches for config files, loads, merges, and validates.

```typescript
function loadConfig(configPath?: string): AgentOrchestratorConfig;
```

### `defaultConfig()`

Returns the default configuration with all fallback values.

```typescript
function defaultConfig(): AgentOrchestratorConfig;
```

**Defaults:**

| Field | Default |
|-------|---------|
| `server.port` | `0` |
| `server.host` | `'127.0.0.1'` |
| `server.shutdownTimeoutMs` | `15000` |
| `websocket.heartbeatIntervalMs` | `30000` |
| `websocket.idleTimeoutMs` | `600000` |
| `orchestrator.maxInstances` | `10` |
| `orchestrator.idleTimeoutMs` | `600000` |
| `orchestrator.idleSweepIntervalMs` | `60000` |
| `orchestrator.portRange` | `{ start: 30000, end: 30100, allowDynamicFallback: true }` |
| `orchestrator.defaultAgentType` | `'opencode-direct'` |
| `orchestrator.healthCheck` | `{ retries: 10, intervalMs: 500, clientTimeoutMs: 5000 }` |
| `orchestrator.sse` | `{ enabled: true, reconnectMaxAttempts: 10, reconnectBaseMs: 1000, filterHeartbeat: true }` |
| `workspace.basePath` | `'./workspace'` |
| `workspace.enforceCanonicalConfig` | `true` |
| `workspace.maxSizeBytes` | `52428800` (50MB) |
| `workspace.storage` | `{ type: 'local' }` |
| `cluster.enabled` | `false` |
| `logging.file.enabled` | `false` |
| `logging.file.directory` | `'./logs'` |
| `logging.file.maxFileSizeBytes` | `10485760` (10 MiB) |
| `logging.file.maxRotatedFiles` | `10` |
| `logging.file.retentionMs` | `604800000` (7 days) |
| `cleanup.ownerId` | `null` |
| `cleanup.sweepIntervalMs` | `3600000` (1 hour) |
| `cleanup.orphanedData.enabled` | `false` |
| `cleanup.orphanedData.gracePeriodMs` | `2592000000` (30 days) |

### `normalizeApiKeys(serverConfig)`

Converts legacy `apiKey` string to `apiKeys` array format.

```typescript
function normalizeApiKeys(serverConfig: ServerConfig): ApiKeyEntry[] | undefined;
```

**Behavior:**
- If `apiKeys` is defined and non-empty, returns it as-is
- If `apiKey` is defined (legacy), converts to `[{ key, role: 'admin' }]`
- If neither is defined, returns `undefined`; whether auth is disabled is then
  determined by `server.rbac.enabled`

### `validateConfig(config)`

Validates all configuration fields. Throws `AppError` on invalid values.

**Validation rules:**
- `server.port`: 0-65535
- `server.host`: non-empty string
- `server.apiKeys[].role`: must name a built-in or configured custom role
- `server.apiKeys[].key`: minimum 8 characters
- built-in roles cannot be overridden and custom role names/permissions are validated
- `orchestrator.maxInstances`: must fit the port range when dynamic fallback is disabled
- `orchestrator.portRange.start`: must be less than `end`
- `workspace.maxSizeBytes`: must be >= 0
- `logging.file.directory`: must be non-empty and cannot resolve to a filesystem root
- `cleanup.ownerId`: required when orphan cleanup is enabled
- cleanup intervals, grace periods, and file-rotation limits must be positive safe integers

### `readJSON(path)`

Reads a JSONC file (JSON with Comments). Uses `jsonc-parser` library.

### `loadCanonicalConfig(enforce)`

Loads the canonical OpenCode configuration from `config/canonical-opencode.json`. If `enforce` is true, this config is copied to every workspace.

## Merge Strategy

Configuration merging uses deep merge:

```typescript
// defaults + configFile + envOverrides
const config = deepMerge(defaultConfig(), configFile);
applyEnvOverrides(config);
validateConfig(config);
```

Environment names resolve underscore-separated words to camelCase fields, so
both the documented `MAX_SIZE_BYTES` form and the legacy concatenated
`MAXSIZEBYTES` form work. Arrays such as `runtimes` are opaque and cannot be
overridden through scalar environment variables.

## Type Definitions

### AgentOrchestratorConfig

```typescript
interface AgentOrchestratorConfig {
  server: ServerConfig;
  websocket: WebSocketConfig;
  orchestrator: OrchestratorConfig;
  workspace: WorkspaceConfig;
  roles?: RolesConfig;
  cluster?: ClusterConfig;
  logging: LoggingConfig;
  cleanup: CleanupConfig;
}
```

### ServerConfig

```typescript
interface ServerConfig {
  port: number;
  host: string;
  shutdownTimeoutMs: number;
  apiKey?: string;           // @deprecated
  apiKeys?: ApiKeyEntry[];
  rbac?: { enabled?: boolean };
}

interface ApiKeyEntry {
  key: string;
  role: string;              // built-in or configured custom role
  name?: string;
}
```

### OrchestratorConfig

```typescript
interface OrchestratorConfig {
  maxInstances: number;
  idleTimeoutMs: number;
  idleSweepIntervalMs: number;
  portRange: { start: number; end: number; allowDynamicFallback?: boolean };
  defaultAgentType: string;
  runtimes: RuntimeEntry[];
  healthCheck: HealthCheckConfig;
  sse: SSEConfig;
}
```
