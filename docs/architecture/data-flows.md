# Data Flows

This document describes the step-by-step request/response sequences for the most common operations.

## 1. Prepare Conversation

Creates a workspace and conversation record without starting an OpenCode instance.

```
Client                          AgentOrchestrator
  │                                    │
  │  POST /api/conversations           │
  │  { "agentType": "opencode-direct" }│
  │  ─────────────────────────────────►│
  │                                    │
  │                          ┌─────────┴─────────┐
  │                          │ Validate agentType  │
  │                          │ against configured  │
  │                          │ runtimes            │
  │                          └─────────┬─────────┘
  │                                    │
  │                          ┌─────────┴─────────┐
  │                          │ WorkspaceFactory   │
  │                          │ .createWorkspace() │
  │                          │ - Create directory  │
  │                          │ - Copy config       │
  │                          │ - Apply quota       │
  │                          └─────────┬─────────┘
  │                                    │
  │                          ┌─────────┴─────────┐
  │                          │ ConversationState  │
  │                          │ .register(id)      │
  │                          │ Status: prepared   │
  │                          └─────────┬─────────┘
  │                                    │
  │  200 OK                            │
  │  { id, status: "prepared", ... }  │
  │  ◄─────────────────────────────────│
```

**Key state transitions:** None (conversation stays in `prepared` status)

## 2. Start Conversation

Spawns an OpenCode instance and connects to it.

```
Client                          AgentOrchestrator
  │                                    │
  │  POST /api/conversations/:id/start │
  │  ─────────────────────────────────►│
  │                                    │
  │                          ┌─────────┴─────────┐
  │                          │ ConversationState  │
  │                          │ .transition(       │
  │                          │   'starting')      │
  │                          └─────────┬─────────┘
  │                                    │
  │                          ┌─────────┴─────────┐
  │                          │ InstanceManager    │
  │                          │ .startInstance()   │
  │                          └─────────┬─────────┘
  │                                    │
  │                          ┌─────────┴─────────┐
  │                          │ PortPool.allocate()│
  │                          │ Get available port  │
  │                          └─────────┬─────────┘
  │                                    │
  │                          ┌─────────┴─────────┐
  │                          │ WorkspaceFactory   │
  │                          │ .prepareWorkspace()│
  │                          │ - Write config     │
  │                          │ - Write agents     │
  │                          └─────────┬─────────┘
  │                                    │
  │                          ┌─────────┴─────────┐
  │                          │ RuntimeManager     │
  │                          │ .start()           │
  │                          │ - Runtime.spawn()  │
  │                          │ - Health check     │
  │                          │ - Connect SSE      │
  │                          └─────────┬─────────┘
  │                                    │
  │                          ┌─────────┴─────────┐
  │                          │ SSEBridge.connect()│
  │                          │ Subscribe to       │
  │                          │ OpenCode /events   │
  │                          └─────────┬─────────┘
  │                                    │
  │  200 OK                            │
  │  { id, status: "running", port }  │
  │  ◄─────────────────────────────────│
  │                                    │
  │  WS: conversation.running event    │
  │  ◄─────────────────────────────────│
```

**Key state transitions:** `prepared` → `starting` → `running`

## 3. Send Message (WebSocket)

Sends a message to the running OpenCode instance via WebSocket.

```
Client (WS)                  AgentOrchestrator                    OpenCode
  │                                    │                            │
  │  JSON-RPC: message.send            │                            │
  │  { text: "Hello", model: "..." }   │                            │
  │  ─────────────────────────────────►│                            │
  │                                    │                            │
  │                          ┌─────────┴─────────┐                  │
  │                          │ Validate auth      │                  │
  │                          │ (admin required)   │                  │
  │                          └─────────┬─────────┘                  │
  │                                    │                            │
  │                          ┌─────────┴─────────┐                  │
  │                          │ MessageService     │                  │
  │                          │ .send()            │                  │
  │                          │ - Get OpenCode     │                  │
  │                          │   client           │                  │
  │                          │ - Create session   │                  │
  │                          │   if needed        │                  │
  │                          └─────────┬─────────┘                  │
  │                                    │                            │
  │                                    │  POST /session/:id/message │
  │                                    │  { text, model, agent }    │
  │                                    │  ─────────────────────────►│
  │                                    │                            │
  │                                    │  200 OK                    │
  │                                    │  { messageId, text, parts }│
  │                                    │  ◄─────────────────────────│
  │                                    │                            │
  │  JSON-RPC Result                   │                            │
  │  { messageId, text, parts }        │                            │
  │  ◄─────────────────────────────────│                            │
  │                                    │                            │
  │  WS: message.part events           │  (streamed via SSE)        │
  │  ◄─────────────────────────────────│◄───────────────────────────│
```

**Key state transitions:** None (conversation stays in `running` status)

## 4. Delete Conversation

Destroys the OpenCode instance and removes the workspace.

```
Client                          AgentOrchestrator
  │                                    │
  │  DELETE /api/conversations/:id     │
  │  ─────────────────────────────────►│
  │                                    │
  │                          ┌─────────┴─────────┐
  │                          │ ConversationState  │
  │                          │ .transition(       │
  │                          │   'destroying')    │
  │                          └─────────┬─────────┘
  │                                    │
  │                          ┌─────────┴─────────┐
  │                          │ SSEBridge          │
  │                          │ .disconnect()      │
  │                          └─────────┬─────────┘
  │                                    │
  │                          ┌─────────┴─────────┐
  │                          │ RuntimeManager     │
  │                          │ .destroy()         │
  │                          │ - Runtime.kill()   │
  │                          │ - PortPool.release()│
  │                          └─────────┬─────────┘
  │                                    │
  │                          ┌─────────┴─────────┐
  │                          │ WorkspaceFactory   │
  │                          │ .deleteWorkspace() │
  │                          │ - Remove directory  │
  │                          └─────────┬─────────┘
  │                                    │
  │                          ┌─────────┴─────────┐
  │                          │ ConversationState  │
  │                          │ .unregister(id)    │
  │                          └─────────┬─────────┘
  │                                    │
  │  204 No Content                    │
  │  ◄─────────────────────────────────│
  │                                    │
  │  WS: conversation.destroyed event  │
  │  ◄─────────────────────────────────│
```

**Key state transitions:** `running` → `destroying` → (removed)

## 5. Idle Timeout

The orchestrator automatically destroys idle instances.

```
Orchestrator (Background)       ConversationState
  │                                    │
  │  Every idleSweepIntervalMs:        │
  │  ┌─────────────────────────┐       │
  │  │ Check each instance:    │       │
  │  │ - Is status 'running'?  │       │
  │  │ - Last activity >       │       │
  │  │   idleTimeoutMs?        │       │
  │  └────────────┬────────────┘       │
  │               │                    │
  │               │ (if idle)          │
  │               │                    │
  │  ┌────────────▼────────────┐       │
  │  │ InstanceManager         │       │
  │  │ .destroy(id)            │──────►│
  │  └────────────┬────────────┘  emit│
  │               │           'idle.  │
  │               │            timeout'│
  │               │                    │
  │  ┌────────────▼────────────┐       │
  │  │ SSEBridge.disconnect()  │       │
  │  └────────────┬────────────┘       │
  │               │                    │
  │  ┌────────────▼────────────┐       │
  │  │ RuntimeManager.destroy()│       │
  │  └────────────┬────────────┘       │
  │               │                    │
  │  ┌────────────▼────────────┐       │
  │  │ WorkspaceFactory        │       │
  │  │ .deleteWorkspace()      │       │
  │  └────────────┬────────────┘       │
  │               │                    │
  │  ┌────────────▼────────────┐       │
  │  │ ConversationState       │       │
  │  │ .unregister(id)         │       │
  │  └─────────────────────────┘       │
```

## Error Paths

### Health Check Failure

When `RuntimeManager.start()` is called, it performs a health check loop:

1. Spawn the OpenCode instance (DirectRuntime or DockerRuntime)
2. Wait `healthCheck.intervalMs` (default 500ms)
3. Send `GET /health` to the OpenCode HTTP API
4. If response is 200 OK, mark as `running`
5. If not, retry up to `healthCheck.retries` times (default 10)
6. If all retries fail, transition to `stopped` with `lastError` set
7. Release port back to pool

### Workspace Quota Exceeded

When `WorkspaceFactory.write()` is called:

1. Calculate current workspace size
2. If `maxSizeBytes > 0` and current size + new content > `maxSizeBytes`:
   - Throw `AppError(413, 'WORKSPACE_QUOTA_EXCEEDED')`
3. If `maxSizeBytes === 0`, skip quota check entirely (unlimited)

### Runtime Spawn Failure

When `DirectRuntime.spawn()` or `DockerRuntime.spawn()` fails:

1. Catch the error
2. Transition conversation to `stopped` with `lastError: error.message`
3. Release port back to pool
4. Emit `conversation.stopped` event
5. The conversation can be restarted via `POST /api/conversations/:id/restart`

### Session Creation Failure

When `SessionService.create()` cannot reach the OpenCode instance:

1. Return error to the client
2. The conversation remains in `running` status
3. The client can retry or check connection via `GET /api/conversations/:id`
