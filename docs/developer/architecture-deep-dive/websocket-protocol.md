# WebSocket Protocol

This document describes the WebSocket implementation details.

## Connection Setup

### URL Format

```
ws://localhost:8080/ws/{conversationId}?apiKey={key}
```

### Upgrade Flow

1. Client sends HTTP upgrade request
2. Server extracts `conversationId` from URL path
3. Server validates `conversationId` (alphanumeric + hyphens only)
4. Server checks `?apiKey=` query param or `x-api-key` header
5. Server looks up role from `resolvedApiKeys`
6. Server checks if existing connection exists for this conversation
7. If exists: send `connection.replaced` event to old connection, close it
8. Create new `WebSocketConnection`
9. Subscribe to `ConversationState` events for this conversation
10. Send initial events (if any)

### Authentication

```typescript
// In HTTP upgrade handler
const apiKey = url.searchParams.get('apiKey') || headers['x-api-key'];
const role = resolvedApiKeys?.find(entry => entry.key === apiKey)?.role;
connectionRoles.set(connectionId, role);
```

If `resolvedApiKeys` is empty, no auth is required (all connections are allowed).

## JSON-RPC 2.0

### Request Format

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "message.send",
  "params": { "text": "Hello" }
}
```

### Response Format

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": { "messageId": "msg-123", "text": "Response" }
}
```

### Error Format

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32600,
    "message": "Write operations require admin role"
  }
}
```

### Standard Error Codes

| Code | Meaning |
|------|---------|
| `-32700` | Parse error |
| `-32600` | Invalid request |
| `-32601` | Method not found |
| `-32602` | Invalid params |
| `-32603` | Internal error |

## Method Routing

### Connection Lifecycle

```
1. Connection established
   │
2. Register in connections Map
   │
3. Subscribe to ConversationState events
   │
4. Handle incoming messages:
   ├── Parse JSON-RPC request
   ├── Validate method exists
   ├── Check role permissions
   ├── Route to handler
   └── Send response
   │
5. Handle events:
   ├── Receive event from ConversationState
   └── Push to client as JSON-RPC notification
```

### Permission Check

```typescript
const WRITE_METHODS = new Set([
  'message.send',
  'config.update', 'config.patch',
  'agent.register', 'agent.delete',
  'agent.config.write', 'agent.config.delete',
  'file.write', 'file.delete', 'file.copy',
  'session.create', 'session.delete', 'session.fork', 'session.abort',
  'skills.import', 'skills.delete',
  'conversation.start', 'conversation.stop', 'conversation.restart', 'conversation.delete',
]);

// In handleMessage:
if (WRITE_METHODS.has(method) && role === 'observer') {
  throw new AppError(403, FORBIDDEN, 'Write operations require admin role');
}
```

### Method Dispatch

```typescript
const handlers: Record<string, Handler> = {
  'message.send': handleMessageSend,
  'message.history': handleMessageHistory,
  'config.get': handleConfigGet,
  'config.update': handleConfigUpdate,
  'agent.list': handleAgentList,
  // ... 20+ methods
};
```

## Event Pushing

### Subscriber Registration

```typescript
conversationState.subscribe(conversationId, (event) => {
  connection.sendEvent(event);
});
```

### Event Format

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "type": "message.part",
    "data": { "text": "Hello" },
    "timestamp": "2026-01-01T00:00:00.000Z"
  }
}
```

### Connection Cleanup

When a conversation is destroyed:

```typescript
conversationState.subscribe(conversationId, (event) => {
  if (event.type === 'conversation.destroyed') {
    // Wait 2000ms for client to process event
    setTimeout(() => {
      connection.close(1001, 'Conversation destroyed');
    }, 2000);
  }
});
```

## Connection Management

### One Connection Per Conversation

```typescript
// If new connection for same conversationId:
const existing = this.connections.get(conversationId);
if (existing) {
  existing.sendEvent({ type: 'connection.replaced' });
  existing.close(1000, 'Replaced by new connection');
}
this.connections.set(conversationId, newConnection);
```

### Heartbeat

Server sends periodic heartbeats to keep connections alive:

```typescript
// Every heartbeatIntervalMs (default: 30000ms)
connection.ping();
```

### Idle Timeout

Connections idle for `idleTimeoutMs` (default: 600000ms) are closed:

```typescript
// Check every heartbeatIntervalMs
if (Date.now() - lastActivity > idleTimeoutMs) {
  connection.close(1000, 'Idle timeout');
}
```

## Close Codes

| Code | Meaning |
|------|---------|
| `1000` | Normal closure |
| `1001` | Server shutting down |
| `1002` | Protocol error |
| `1003` | Unsupported data |
| `1008` | Policy violation |
| `1011` | Internal error |
