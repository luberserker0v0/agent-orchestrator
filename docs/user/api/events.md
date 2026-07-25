# SSE Events

AgentOrchestrator forwards Server-Sent Events (SSE) from OpenCode instances to WebSocket clients. This document describes the event types and their payloads.

## Event Flow

```
OpenCode Instance
  │
  │  SSE /global/event
  │
  ▼
OpenCodeSSEClient
  │
  │  handleEvent()
  │
  ▼
SSEBridge
  │
  │  emitEvent()
  │
  ▼
ConversationState
  │
  │  subscriber callback
  │
  ▼
WSRouter → WebSocket Client
```

## Event Types

### Conversation Lifecycle

| Event | Description | Data |
|-------|-------------|------|
| `conversation.running` | Instance started and ready | `{ status: 'running' }` |
| `conversation.stopped` | Instance stopped | `{ status: 'stopped' }` |
| `conversation.error` | Instance error occurred | `{ status: 'error', lastError: '...' }` |
| `conversation.destroyed` | Conversation deleted | `{ status: 'destroying' }` |

### Message Events

| Event | Description | Data |
|-------|-------------|------|
| `message.part` | Message part received | `{ text, type, ... }` |
| `message.complete` | Message fully received | `{ messageId, text, parts }` |

### Configuration Events

| Event | Description | Data |
|-------|-------------|------|
| `conversation.configChanged` | Config, agent, or file modified | `{ needsRestart: true }` |

### Session Events

| Event | Description | Data |
|-------|-------------|------|
| `session.created` | New session created | `{ sessionID }` |
| `session.updated` | Session updated | `{ sessionID }` |

### Instance Events

| Event | Description | Data |
|-------|-------------|------|
| `idle.timeout` | Instance destroyed due to idle timeout | `{ id }` |

## Heartbeat Events

OpenCode sends heartbeat events periodically to keep connections alive. By default, these are filtered out by AgentOrchestrator to reduce noise.

To see heartbeat events, set `orchestrator.sse.filterHeartbeat` to `false`:

```jsonc
{
  "orchestrator": {
    "sse": {
      "filterHeartbeat": false
    }
  }
}
```

## SSE Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `sse.enabled` | boolean | `true` | Enable SSE event forwarding |
| `sse.reconnectMaxAttempts` | integer | `10` | Max reconnect attempts |
| `sse.reconnectBaseMs` | integer | `1000` | Base delay for exponential backoff |
| `sse.filterHeartbeat` | boolean | `true` | Filter heartbeat events |

## REST API: Get Events

You can also retrieve recent events via REST:

```bash
curl http://localhost:8080/api/conversations/abc123/events?limit=50
```

Response:
```json
{
  "events": [
    {
      "type": "message.part",
      "data": { "text": "Hello" },
      "timestamp": "2026-01-01T00:00:00.000Z"
    },
    ...
  ]
}
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 50 | Max events to return (max 100) |

## Event Replay

When a WebSocket client connects, it does **not** receive past events. Only new events from the connection time onward are pushed.

To get historical events, use the REST API endpoint above.
