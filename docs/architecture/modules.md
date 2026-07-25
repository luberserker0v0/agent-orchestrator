# Modules Reference

This document describes all core modules in the AgentOrchestrator codebase.

## Service Layer

Services handle business logic and orchestrate between domain objects and external APIs.

### ConversationService

**File:** `src/services/conversation-service.ts`

Manages the full lifecycle of conversations: creation, startup, shutdown, and deletion.

| Method | Signature | Description |
|--------|-----------|-------------|
| `create` | `(id?, agentType?): Promise<ConversationData>` | Create conversation + workspace |
| `get` | `(id): ConversationData` | Get single conversation |
| `list` | `(): ConversationData[]` | List all conversations |
| `getEvents` | `(id, limit?): ConversationEvent[]` | Get recent events |
| `start` | `(id): Promise<StartResult>` | Start OpenCode instance |
| `stop` | `(id): Promise<void>` | Stop instance |
| `restart` | `(id): Promise<StartResult>` | Restart instance |
| `delete` | `(id): Promise<void>` | Destroy instance + remove workspace |

### ConfigService

**File:** `src/services/config-service.ts`

Reads, writes, and patches the OpenCode configuration (`opencode.json`).

| Method | Signature | Description |
|--------|-----------|-------------|
| `readConfig` | `(id): Promise<OpencodeConfig>` | Read opencode.json |
| `writeConfig` | `(id, config): Promise<void>` | Write opencode.json |
| `patchConfig` | `(id, patch): Promise<void>` | Deep-merge patch into config |

### AgentService

**File:** `src/services/agent-service.ts`

Manages agent definition files (markdown files with agent instructions).

| Method | Signature | Description |
|--------|-----------|-------------|
| `writeAgent` | `(id, name, content): void` | Write agent markdown file |
| `readAgent` | `(id, name): string` | Read agent content |
| `deleteAgent` | `(id, name): void` | Delete agent file |
| `listAgents` | `(id): string[]` | List agent names |
| `listAgentsWithRuntime` | `(id): Promise<string[] \| AgentItem[]>` | List agents with runtime info |
| `writeAgentsMd` | `(id, content): void` | Write AGENTS.md |
| `readAgentsMd` | `(id): string` | Read AGENTS.md |
| `deleteAgentsMd` | `(id): void` | Delete AGENTS.md |

### MessageService

**File:** `src/services/message-service.ts`

Sends messages to OpenCode instances and retrieves message history.

| Method | Signature | Description |
|--------|-----------|-------------|
| `send` | `(id, text, rawModel?, rawAgent?): Promise<SendResult>` | Send message to OpenCode |
| `getHistory` | `(id, sessionId?, limit?): Promise<unknown[]>` | Get message history |

### FileService

**File:** `src/services/file-service.ts`

Manages files within conversation workspaces with path traversal protection.

| Method | Signature | Description |
|--------|-----------|-------------|
| `write` | `(id, path, content): Promise<void>` | Write file |
| `read` | `(id, path): Promise<string>` | Read file |
| `delete` | `(id, path): Promise<void>` | Delete file |
| `copy` | `(id, source, dest): Promise<void>` | Copy file |
| `list` | `(id, path?): Promise<string[]>` | List files |

### SessionService

**File:** `src/services/session-service.ts`

Manages OpenCode sessions (conversations within a conversation).

| Method | Signature | Description |
|--------|-----------|-------------|
| `create` | `(id, params?): Promise<unknown>` | Create session |
| `list` | `(id): Promise<unknown[]>` | List sessions |
| `get` | `(id, sessionId): Promise<unknown>` | Get session |
| `delete` | `(id, sessionId): Promise<void>` | Delete session |
| `fork` | `(id, sessionId, messageID?): Promise<unknown>` | Fork session |
| `getChildren` | `(id, sessionId): Promise<unknown[]>` | Get session children |
| `abort` | `(id): Promise<{ aborted: boolean }>` | Abort current session |
| `listProviders` | `(id): Promise<ProviderListResult>` | List providers |

### SkillService

**File:** `src/services/skill-service.ts`

Manages skills (reusable instruction sets) for conversations and agents.

| Method | Signature | Description |
|--------|-----------|-------------|
| `uploadSkill` | `(id, name, zipBuffer, agentName?): Promise<void>` | Upload skill from zip |
| `importSkill` | `(id, source, name, agentName?): Promise<void>` | Import skill from local dir |
| `listSkills` | `(id, agentName?): string[]` | List skill names |
| `readSkill` | `(id, name, agentName?): string` | Read SKILL.md |
| `getSkillInfo` | `(id, name, agentName?): SkillInfo` | Get skill metadata |
| `deleteSkill` | `(id, name, agentName?): void` | Delete skill |

## Domain Layer

Domain objects manage state, resources, and lifecycle.

### ConversationState

**File:** `src/orchestrator/conversation-state.ts`

The single source of truth for conversation state. Event-driven with subscription support.

| Method | Signature | Description |
|--------|-----------|-------------|
| `register` | `(id, agentType?): void` | Register new conversation |
| `unregister` | `(id): void` | Remove conversation |
| `transition` | `(id, status, meta?): void` | Transition to new status |
| `get` | `(id): ConversationData` | Get conversation data |
| `list` | `(): ConversationData[]` | List all conversations |
| `subscribe` | `(id, callback): () => void` | Subscribe to events |
| `emitEvent` | `(id, event): void` | Emit event to subscribers |

**Status values:** `prepared`, `starting`, `running`, `stopping`, `stopped`, `destroying`, `error`

### InstanceManager

**File:** `src/orchestrator/instance-manager.ts`

Manages the OpenCode instance map and lifecycle policy.

| Method | Signature | Description |
|--------|-----------|-------------|
| `startInstance` | `(id, agentType?): Promise<StartResult>` | Start instance |
| `stopInstance` | `(id): Promise<void>` | Stop instance |
| `restartInstance` | `(id): Promise<StartResult>` | Restart instance |
| `destroy` | `(id): Promise<void>` | Destroy instance |
| `getIdleCandidates` | `(): string[]` | Get instances eligible for idle timeout |
| `isIdle` | `(id): boolean` | Check if instance is idle |

### PortPool

**File:** `src/orchestrator/port-pool.ts`

Dynamic port allocation from a configurable range.

| Method | Signature | Description |
|--------|-----------|-------------|
| `allocate` | `(): number` | Allocate an available port |
| `release` | `(port: number): void` | Release a port back to pool |
| `available` | `(): number` | Get count of available ports |

### WorkspaceFactory

**File:** `src/orchestrator/workspace-factory.ts`

Creates and manages conversation workspaces (directories with config, agents, files).

| Method | Signature | Description |
|--------|-----------|-------------|
| `createWorkspace` | `(id, agentType?): WorkspaceInfo` | Create workspace directory |
| `deleteWorkspace` | `(id): void` | Remove workspace |
| `prepareWorkspace` | `(id): void` | Write config + agents to workspace |
| `getWorkspacePath` | `(id): string` | Get workspace absolute path |
| `write` | `(id, path, content): void` | Write file (with quota check) |
| `read` | `(id, path): string` | Read file |
| `delete` | `(id, path): void` | Delete file |
| `list` | `(id, path?): string[]` | List files |
| `copy` | `(id, source, dest): void` | Copy file |
| `sanitizePath` | `(input): string` | Sanitize path (traversal protection) |

### SSEBridge

**File:** `src/orchestrator/sse-bridge.ts`

Bridges Server-Sent Events from OpenCode instances to the event system.

| Method | Signature | Description |
|--------|-----------|-------------|
| `connect` | `(id, port, password): void` | Connect to OpenCode SSE endpoint |
| `disconnect` | `(): void` | Disconnect from all SSE streams |
| `handleEvent` | `(id, event): void` | Process incoming SSE event |

## Runtime Abstraction Layer

Provides a pluggable system for spawning OpenCode instances.

### Runtime Interface

**File:** `src/agent-runtime/types.ts`

```typescript
interface Runtime {
  spawn(config: SpawnConfig): Promise<RuntimeHandle>;
  kill(handle: RuntimeHandle): Promise<void>;
  healthCheck(port: number, password: string): Promise<boolean>;
}

interface RuntimeHandle {
  pid?: number;
  containerName?: string;
  port: number;
}
```

### RuntimeRegistry

**File:** `src/agent-runtime/registry.ts`

Maps runtime type IDs to Runtime implementations.

| Method | Signature | Description |
|--------|-----------|-------------|
| `register` | `(id, runtime): void` | Register runtime |
| `get` | `(id): Runtime` | Get runtime by ID |
| `has` | `(id): boolean` | Check if runtime exists |
| `list` | `(): string[]` | List registered runtimes |

### RuntimeManager

**File:** `src/agent-runtime/runtime-manager.ts`

Manages the instance map, lifecycle, and policy queries.

| Method | Signature | Description |
|--------|-----------|-------------|
| `start` | `(id, config): Promise<RuntimeHandle>` | Start instance |
| `destroy` | `(id): Promise<void>` | Destroy instance |
| `getHandle` | `(id): RuntimeHandle \| undefined` | Get instance handle |
| `setOnDestroyed` | `(callback): void` | Set destroy callback |

### DirectRuntime

**File:** `src/agent-runtime/runtimes/direct.ts`

Spawns OpenCode as a child process.

| Config Field | Type | Description |
|-------------|------|-------------|
| `binary` | `string` | OpenCode CLI command or path |
| `version` | `string?` | Version hint |
| `instanceHost` | `string?` | Hostname (default: `127.0.0.1`) |

### DockerRuntime

**File:** `src/agent-runtime/runtimes/docker.ts`

Spawns OpenCode in a Docker container.

| Config Field | Type | Description |
|-------------|------|-------------|
| `image` | `string` | Docker image name |
| `instanceHost` | `string?` | Hostname (default: `127.0.0.1`) |
| `networkMode` | `string?` | Docker network mode |

## Supporting Modules

### HTTP Server

**File:** `src/http-api/server.ts`

Express 5 HTTP server with middleware stack: body parsing, CORS, security headers, auth, metrics, dashboard.

### WebSocket Router

**File:** `src/websocket/router.ts`

JSON-RPC 2.0 WebSocket handler with 20+ methods, event pushing, and role-based access control.

### Config Loader

**File:** `src/config-loader.ts`

Loads JSONC configuration with env var overrides, validates all fields, and provides defaults.

### Metrics Registry

**File:** `src/metrics/registry.ts`

Prometheus metrics via `prom-client`. See [Monitoring](../user/runbook/monitoring.md) for available metrics.
