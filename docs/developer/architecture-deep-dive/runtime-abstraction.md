# Runtime Abstraction

This document describes the runtime abstraction layer that supports multiple ways to spawn OpenCode instances.

## Architecture

```
┌─────────────────────────────────────────────┐
│              RuntimeManager                  │
│  - Manages instance map                     │
│  - Handles lifecycle (start/stop/restart)   │
│  - Policy queries (idle detection)          │
└──────────────────────┬──────────────────────┘
                       │
┌──────────────────────▼──────────────────────┐
│              RuntimeRegistry                 │
│  - Maps type IDs to Runtime implementations │
│  - Validates runtime entries                │
└──────────────────────┬──────────────────────┘
                       │
         ┌─────────────┴─────────────┐
         │                           │
┌────────▼────────┐       ┌─────────▼────────┐
│  DirectRuntime   │       │  DockerRuntime   │
│  - child_process │       │  - docker CLI    │
│  - treeKill      │       │  - docker rm -f  │
└─────────────────┘       └──────────────────┘
```

## Runtime Interface

```typescript
interface Runtime {
  spawn(config: SpawnConfig): Promise<RuntimeHandle>;
  kill(handle: RuntimeHandle): Promise<void>;
  healthCheck(port: number, password: string): Promise<boolean>;
}

interface RuntimeHandle {
  pid?: number;           // DirectRuntime: process ID
  containerName?: string; // DockerRuntime: container name
  port: number;           // Instance port
}

interface SpawnConfig {
  id: string;
  port: number;
  password: string;
  workspacePath: string;
  config: RuntimeEntry;
}
```

## DirectRuntime

Spawns OpenCode as a child process using `cross-spawn`.

### Spawn Flow

1. Resolve binary path (from `config.binary`)
2. Set environment variables:
   - `OPENCODE_SERVER_PORT` — Allocated port
   - `OPENCODE_SERVER_PASSWORD` — Ephemeral password
   - `OPENCODE_WORKSPACE_PATH` — Workspace directory
3. Spawn process with `cross-spawn`
4. Store PID in handle
5. Return handle

### Kill Flow

1. Use `tree-kill` to kill process tree
2. Wait for process to exit
3. Clean up handle

### Health Check

```typescript
async healthCheck(port: number, password: string): Promise<boolean> {
  const res = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { 'Authorization': `Bearer ${password}` },
    signal: AbortSignal.timeout(5000),
  });
  return res.ok;
}
```

### Configuration

```jsonc
{
  "id": "opencode-direct",
  "type": "direct",
  "config": {
    "binary": "opencode",      // Command or absolute path
    "version": "1.17.8",       // Optional version hint
    "instanceHost": "127.0.0.1" // Optional hostname
  }
}
```

## DockerRuntime

Spawns OpenCode in a Docker container using the Docker CLI.

### Spawn Flow

1. Generate container name: `ao-{conversationId}-{timestamp}`
2. Set environment variables:
   - `OPENCODE_SERVER_PORT` — Container port
   - `OPENCODE_SERVER_PASSWORD` — Ephemeral password
   - `OPENCODE_WORKSPACE_PATH` — Mounted workspace path
3. Run `docker run` with:
   - Port mapping (unless `networkMode: host`)
   - Volume mounts (workspace)
   - Network mode configuration
   - Environment variables
4. Store container name in handle
5. Return handle

### Kill Flow

1. Run `docker rm -f {containerName}`
2. Wait for container to exit
3. Clean up handle

### Health Check

Same as DirectRuntime — HTTP GET to `/health` endpoint.

### Configuration

```jsonc
{
  "id": "opencode-docker",
  "type": "docker",
  "config": {
    "image": "ghcr.io/anomalyco/opencode:1.17.8",
    "instanceHost": "127.0.0.1",
    "networkMode": "host"  // Optional: host, bridge, or custom
  }
}
```

### Network Modes

| Mode | Port Mapping | Use Case |
|------|-------------|----------|
| `host` | Skipped | Best performance, no isolation |
| `bridge` | Required | Default Docker networking |
| Custom | Required | Multi-container setups |

## RuntimeRegistry

Maps runtime type IDs to implementations.

```typescript
class RuntimeRegistry {
  register(id: string, runtime: Runtime): void;
  get(id: string): Runtime;
  has(id: string): boolean;
  list(): string[];
}
```

**Registration at startup:**

```typescript
const registry = new RuntimeRegistry();
registry.register('direct', new DirectRuntime());
registry.register('docker', new DockerRuntime());
```

## RuntimeManager

Manages the instance map and lifecycle.

```typescript
class RuntimeManager {
  async start(id: string, config: SpawnConfig): Promise<RuntimeHandle>;
  async destroy(id: string): Promise<void>;
  getHandle(id: string): RuntimeHandle | undefined;
  setOnDestroyed(callback: OnDestroyedCallback): void;
}
```

### Instance Map

```typescript
private instances: Map<string, {
  handle: RuntimeHandle;
  runtime: Runtime;
  conversationId: string;
}>;
```

### Destroy Callback

When an instance is destroyed (by idle timeout or error), the manager calls the registered callback:

```typescript
runtimeManager.setOnDestroyed((id, reason) => {
  // 1. Stop SSE bridge
  // 2. Cancel health check
  // 3. Transition conversation to 'stopped'
  // 4. Emit 'conversation.stopped' event
});
```

## Adding a New Runtime

To add a new runtime (e.g., Kubernetes pod):

1. Implement the `Runtime` interface:

```typescript
class KubernetesRuntime implements Runtime {
  async spawn(config: SpawnConfig): Promise<RuntimeHandle> {
    // Create pod, wait for ready
  }
  
  async kill(handle: RuntimeHandle): Promise<void> {
    // Delete pod
  }
  
  async healthCheck(port: number, password: string): Promise<boolean> {
    // Check pod health
  }
}
```

2. Register in `src/index.ts`:

```typescript
registry.register('kubernetes', new KubernetesRuntime());
```

3. Add config type in `config-loader.ts`:

```typescript
interface KubernetesRuntimeConfig {
  kubeconfig?: string;
  namespace: string;
  image: string;
}
```

4. Use in config:

```jsonc
{
  "orchestrator": {
    "runtimes": [
      { "id": "oc-k8s", "type": "kubernetes", "config": { "namespace": "default", "image": "..." } }
    ]
  }
}
```
