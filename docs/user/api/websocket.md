# WebSocket API

AgentOrchestrator exposes a JSON-RPC 2.0 WebSocket API for real-time communication.

## Connection

```
ws://localhost:8080/ws/{conversationId}?apiKey={key}
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `conversationId` | Yes | The conversation ID to connect to |
| `apiKey` | If configured | API key for authentication |

**Note:** Only one WebSocket connection per conversation is allowed. A new connection replaces the existing one (the old connection receives a `connection.replaced` event and is closed).

## JSON-RPC 2.0 Format

### Request

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "message.send",
  "params": {
    "text": "Hello"
  }
}
```

### Success Response

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "messageId": "msg-abc123",
    "text": "Response text",
    "parts": [...]
  }
}
```

### Error Response

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

## Methods

### Read Methods (Admin + Observer)

| Method | Params | Description |
|--------|--------|-------------|
| `conversation.status` | `{}` | Get conversation status and last error |
| `message.history` | `{ sessionID?, limit? }` | Get message history |
| `config.get` | `{}` | Read OpenCode config |
| `agent.list` | `{}` | List agents |
| `agent.get` | `{ name }` | Get agent content |
| `agent.config.get` | `{}` | Read AGENTS.md |
| `file.read` | `{ path }` | Read a file |
| `file.list` | `{ path? }` | List files |
| `session.list` | `{}` | List sessions |
| `session.get` | `{ sessionID }` | Get session details |
| `session.children` | `{ sessionID }` | Get session children |
| `providers.list` | `{}` | List providers |
| `skills.list` | `{}` | List skills |
| `skills.get` | `{ name }` | Read skill SKILL.md |
| `skills.info` | `{ name }` | Get skill info |

### Write Methods (Admin Only)

| Method | Params | Description |
|--------|--------|-------------|
| `message.send` | `{ text, model?, agent? }` | Send message |
| `config.update` | `{ config }` | Write full config |
| `config.patch` | `{ patch }` | Patch config (deep merge) |
| `agent.register` | `{ name, content }` | Write agent |
| `agent.delete` | `{ name }` | Delete agent |
| `agent.config.write` | `{ content }` | Write AGENTS.md |
| `agent.config.delete` | `{}` | Delete AGENTS.md |
| `file.write` | `{ path, content }` | Write file |
| `file.delete` | `{ path }` | Delete file |
| `file.copy` | `{ source, dest }` | Copy file |
| `session.create` | `{ title?, parentID? }` | Create session |
| `session.delete` | `{ sessionID }` | Delete session |
| `session.fork` | `{ sessionID, messageID? }` | Fork session |
| `session.abort` | `{}` | Abort current session |
| `skills.import` | `{ source, name, agent? }` | Import skill |
| `skills.delete` | `{ name }` | Delete skill |
| `conversation.start` | `{}` | Start OpenCode instance |
| `conversation.stop` | `{}` | Stop instance |
| `conversation.restart` | `{}` | Restart instance |
| `conversation.delete` | `{}` | Delete conversation |

## Events

The server pushes events to connected WebSocket clients. See [SSE Events](events.md) for event types.

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "type": "message.part",
    "data": { ... }
  }
}
```

## Special Events

| Event | Description |
|-------|-------------|
| `connection.replaced` | Sent when a new connection replaces this one. Connection will be closed after this event. |
| `conversation.destroyed` | Sent when the conversation is deleted. Connection will be closed after 2000ms. |

## Example: Send Message

```javascript
const ws = new WebSocket('ws://localhost:8080/ws/abc123?apiKey=admin-key');

ws.onopen = () => {
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'message.send',
    params: { text: 'Hello, can you help me?' }
  }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id === 1) {
    console.log('Response:', msg.result);
  } else if (msg.method === 'event') {
    console.log('Event:', msg.params.type, msg.params.data);
  }
};
```

## Example: Subscribe to Events

```javascript
const ws = new WebSocket('ws://localhost:8080/ws/abc123?apiKey=observer-key');

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.method === 'event') {
    switch (msg.params.type) {
      case 'message.part':
        process.stdout.write(msg.params.data.text || '');
        break;
      case 'conversation.running':
        console.log('Instance is ready');
        break;
      case 'conversation.stopped':
        console.log('Instance stopped');
        break;
    }
  }
};
```
