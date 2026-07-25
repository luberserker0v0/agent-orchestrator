# Conversation Lifecycle

This document describes the conversation state machine and event system.

## State Machine

```
                    ┌─────────────┐
                    │  (created)  │
                    └──────┬──────┘
                           │ register()
                           ▼
                    ┌─────────────┐
                    │  prepared   │
                    └──────┬──────┘
                           │ start()
                           ▼
                    ┌─────────────┐
               ┌───►│  starting   │
               │    └──────┬──────┘
               │           │ health check passed
               │           ▼
               │    ┌─────────────┐
               │    │  running    │◄──────────────┐
               │    └──────┬──────┘               │
               │           │                       │ restart()
               │           │ stop()                │
               │           ▼                       │
               │    ┌─────────────┐               │
               │    │  stopping   │───────────────┘
               │    └──────┬──────┘
               │           │
               │           ▼
               │    ┌─────────────┐
               │    │  stopped    │
               │    └──────┬──────┘
               │           │ restart()
               └───────────┘
                           │ delete()
                           ▼
                    ┌─────────────┐
                    │ destroying  │
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │ (unregistered)
                    └─────────────┘
```

## State Transitions

| From | To | Trigger | Description |
|------|-----|---------|-------------|
| (none) | `prepared` | `register()` | Conversation created |
| `prepared` | `starting` | `start()` | Instance spawn initiated |
| `starting` | `running` | Health check passed | Instance ready |
| `starting` | `stopped` | Health check failed | Spawn failed |
| `running` | `stopping` | `stop()` | Stop initiated |
| `stopping` | `stopped` | Stop complete | Instance stopped |
| `stopped` | `starting` | `restart()` | Restart initiated |
| `running` | `starting` | `restart()` | Restart initiated |
| `running` | `stopped` | Idle timeout | Auto-destroyed |
| Any | `destroying` | `delete()` | Delete initiated |
| `destroying` | (unregistered) | Cleanup complete | Removed |

## Event System

### ConversationState

The `ConversationState` class is the single source of truth. All state changes emit events.

```typescript
class ConversationState {
  register(id: string, agentType?: string): void;
  unregister(id: string): void;
  transition(id: string, status: ConversationStatus, meta?: object): void;
  subscribe(id: string, callback: EventCallback): () => void;
  emitEvent(id: string, event: ConversationEvent): void;
}
```

### Event Types

| Event | Emitted When |
|-------|-------------|
| `conversation.running` | Instance started |
| `conversation.stopped` | Instance stopped |
| `conversation.error` | Instance error |
| `conversation.destroyed` | Conversation deleted |
| `conversation.configChanged` | Config/agent/file modified |
| `message.part` | Message part received |
| `message.complete` | Message fully received |
| `session.created` | Session created |
| `idle.timeout` | Idle timeout triggered |

### Subscriber Flow

```
1. WSRouter subscribes to ConversationState
   │
2. SSEBridge receives event from OpenCode
   │
3. SSEBridge calls conversationState.emitEvent()
   │
4. ConversationState notifies all subscribers
   │
5. WSRouter pushes event to WebSocket client
   │
6. Dashboard displays event in timeline
```

### Event Replay

Events are **not** persisted. When a WebSocket client connects, it only receives events from that point forward. Historical events are available via the REST API:

```bash
GET /api/conversations/:id/events?limit=50
```

## Instance Lifecycle

### Start Sequence

1. Validate conversation exists and is in `prepared` or `stopped` state
2. Transition to `starting`
3. Allocate port from PortPool
4. Prepare workspace (write config, agents, files)
5. Spawn OpenCode instance (DirectRuntime or DockerRuntime)
6. Health check loop (up to `retries` attempts)
7. On success: transition to `running`, connect SSE bridge
8. On failure: transition to `stopped`, set `lastError`, release port

### Stop Sequence

1. Validate conversation exists and is in `running` state
2. Transition to `stopping`
3. Disconnect SSE bridge
4. Kill OpenCode instance (Runtime.kill())
5. Release port back to PortPool
6. Transition to `stopped`

### Delete Sequence

1. If running, stop instance first
2. Transition to `destroying`
3. Disconnect SSE bridge
4. Kill OpenCode instance
5. Release port
6. Delete workspace directory
7. Unregister from ConversationState

### Idle Timeout

Background sweep runs every `idleSweepIntervalMs`:

1. Check each running instance
2. If last activity > `idleTimeoutMs`, destroy it
3. Emit `idle.timeout` event
4. Clean up resources

## Error Handling

### Spawn Failure

- Catch error from Runtime.spawn()
- Transition to `stopped` with `lastError`
- Release port
- Client can retry via `restart()`

### Health Check Failure

- After `retries` attempts, give up
- Transition to `stopped` with `lastError`
- Release port

### SSE Disconnection

- SSEBridge attempts reconnection with exponential backoff
- Up to `reconnectMaxAttempts` attempts
- If all attempts fail, SSE connection is closed
- Conversation remains in `running` status
- SSE will reconnect on next health check cycle
