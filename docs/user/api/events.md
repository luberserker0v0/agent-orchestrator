# Conversation Events

AgentOrchestrator combines its own lifecycle/application events with selected
OpenCode Server-Sent Events (SSE), stores a bounded in-memory history, and
forwards the stream to the conversation WebSocket.

## Event Envelope

```json
{
  "type": "conversation.running",
  "id": "demo",
  "timestamp": 1791331200000,
  "payload": {
    "status": "running"
  }
}
```

`timestamp` is Unix time in milliseconds. Payload shape depends on the event.
Avoid treating undocumented OpenCode payload properties as a stable AO contract.

## AO Events

| Event | Meaning |
|-------|---------|
| `conversation.prepared` | Workspace and conversation state were created. |
| `conversation.starting` | Runtime startup began. |
| `conversation.running` | Runtime health passed; session readiness may still be pending. |
| `conversation.restarting` | Restart or migration replacement began. |
| `conversation.stopped` | Runtime stopped, exited, or was idle-evicted; persistent data remains. |
| `conversation.error` | Lifecycle operation failed; payload includes `error` when available. |
| `conversation.destroyed` | Explicit deletion finished; payload status is `destroyed`. |
| `conversation.ready` | A usable OpenCode session is available. |
| `conversation.readyLost` | The readiness keepalive no longer reaches the session. |
| `conversation.needsRestart` | A running conversation's configuration changed. |
| `conversation.configChanged` | Config, agent, or skill content changed. |
| `conversation.thinking` | AO accepted a message request. |
| `conversation.message` | A message response completed. |
| `conversation.quotaExhausted` | OpenCode returned a normalized quota/rate-limit error. |
| `conversation.migrated` | Kubernetes migration completed; payload includes node/session resumption information. |

## Forwarded OpenCode Events

Forwarded events use an `opencode.` prefix:

| OpenCode source | AO event |
|-----------------|----------|
| `server.connected` | `opencode.connected` |
| `server.heartbeat` | `opencode.heartbeat` |
| `session.created` | `opencode.session.created` |
| `session.updated` | `opencode.session.updated` |
| `message.updated` | `opencode.message.updated` |
| `permission.asked` | `opencode.permission.asked` |
| `permission.replied` | `opencode.permission.replied` |
| `file.changed` | `opencode.file.changed` |

Unknown OpenCode event types are ignored. Heartbeats are filtered by default;
set `orchestrator.sse.filterHeartbeat` to `false` to forward them.

## Retrieve Recent Events

```bash
curl "http://127.0.0.1:8080/api/conversations/demo/events?limit=50" \
  -H "Authorization: Bearer $AOR_API_KEY"
```

The response is a JSON array of event envelopes. `limit` defaults to 50 and is
capped at 100. The caller needs `conversation:events` when RBAC is enabled.

`ConversationState` retains at most 100 events per conversation. This history
is not persisted across AO restarts.

## WebSocket Replay

When a WebSocket connection to `/ws/:conversationId` is accepted, AO sends the
retained in-memory events first and then live events. Only one WebSocket is
active per conversation; a replacement receives `connection.replaced` on the
old socket before AO closes it.

## SSE Configuration

| Field | Default | Description |
|-------|---------|-------------|
| `orchestrator.sse.enabled` | `true` | Enable the OpenCode SSE bridge. |
| `orchestrator.sse.reconnectMaxAttempts` | `10` | Maximum reconnect attempts. |
| `orchestrator.sse.reconnectBaseMs` | `1000` | Base exponential-backoff delay. |
| `orchestrator.sse.filterHeartbeat` | `true` | Drop `server.heartbeat` events. |
