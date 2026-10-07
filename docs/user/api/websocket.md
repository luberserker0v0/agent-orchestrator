# WebSocket API

AgentOrchestrator exposes a JSON-RPC 2.0 WebSocket API for conversation-scoped
commands and live events.

## Connect

```text
ws://localhost:8080/ws/{conversationId}?apiKey={key}
```

The conversation must already exist. When RBAC is enabled, authenticate with
either the `apiKey` query parameter or the `x-api-key` upgrade header. The key's
role must grant the permission required by each method. When RBAC is disabled,
requests run with administrative authority.

Only one WebSocket connection is retained per conversation. A replacement
connection sends `connection.replaced` to the old socket before closing it.

## JSON-RPC messages

Request:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "message.send",
  "params": { "text": "Hello" }
}
```

Success response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": { "info": {}, "parts": [] }
}
```

Application error:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32000,
    "message": "Insufficient permissions",
    "data": { "code": "FORBIDDEN" }
  }
}
```

Malformed JSON returns `-32700`; an invalid JSON-RPC request returns `-32600`.
Method, validation, permission, and service failures use `-32000`. Notifications
without an `id` do not receive a response.

## Methods

Permissions are evaluated against the built-in or custom role associated with
the API key. See [Roles and Permissions](../rbac/roles.md).

| Method | Params | Required permission |
|---|---|---|
| `conversation.status` | `{}` | `conversation:get` |
| `conversation.start` | `{}` | `conversation:start` |
| `conversation.stop` | `{}` | `conversation:stop` |
| `conversation.restart` | `{}` | `conversation:restart` |
| `conversation.delete` | `{}` | `conversation:delete` |
| `message.send` | `{ text, model?, agent? }` | `message:send` |
| `message.history` | `{ sessionId?, limit? }` | `message:history` |
| `config.get` | `{}` | `config:get` |
| `config.update` | `{ config }` | `config:write` |
| `config.patch` | `{ config }` | `config:write` |
| `agent.list` | `{}` | `agent:list` |
| `agent.get` | `{ name }` | `agent:get` |
| `agent.register` | `{ name, content }` | `agent:write` |
| `agent.delete` | `{ name }` | `agent:delete` |
| `agent.config.get` | `{}` | `agent:get` |
| `agent.config.write` | `{ content }` | `agent:write` |
| `agent.config.delete` | `{}` | `agent:delete` |
| `file.list` | `{ path? }` | `file:list` |
| `file.read` | `{ path }` | `file:read` |
| `file.write` | `{ path, content }` | `file:write` |
| `file.copy` | `{ source, dest }` | `file:copy` |
| `file.delete` | `{ path }` | `file:delete` |
| `session.list` | `{}` | `session:list` |
| `session.get` | `{ sessionId }` | `session:get` |
| `session.children` | `{ sessionId }` | `session:children` |
| `session.create` | `{ title?, parentID? }` | `session:create` |
| `session.fork` | `{ sessionId, messageID? }` | `session:fork` |
| `session.abort` | `{}` | `session:abort` |
| `session.delete` | `{ sessionId }` | `session:delete` |
| `providers.list` | `{}` | `provider:list` |
| `skills.list` | `{ agent? }` | `skill:list` |
| `skills.get` | `{ name, agent? }` | `skill:get` |
| `skills.info` | `{ name, agent? }` | `skill:info` |
| `skills.import` | `{ source, name, agent? }` | `skill:import` |
| `skills.delete` | `{ name, agent? }` | `skill:delete` |

`config.get` can return provider configuration containing credentials. Grant
`config:get` only to trusted roles.

## Events

Events are JSON-RPC notifications whose `method` is the event type and whose
`params` is that event's payload:

```json
{
  "jsonrpc": "2.0",
  "method": "conversation.ready",
  "params": {
    "baseUrl": "http://127.0.0.1:30000",
    "agentType": "opencode-direct"
  }
}
```

Recent retained conversation events are replayed immediately after connection,
then new events stream live. See [Conversation Events](events.md) for the event
catalog and replay behavior.

Special notifications are:

| Method | Meaning |
|---|---|
| `connection.replaced` | A newer socket replaced this connection. |
| `conversation.destroyed` | The conversation was deleted; the socket closes about two seconds later. |

## Browser example

```javascript
const ws = new WebSocket('ws://localhost:8080/ws/abc123?apiKey=replace-with-key');

ws.onopen = () => {
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'message.send',
    params: { text: 'Hello, can you help me?' },
  }));
};

ws.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (message.id === 1) {
    console.log('RPC result:', message.result);
  } else if (message.method) {
    console.log('Event:', message.method, message.params);
  }
};
```

The server sends WebSocket ping frames at `websocket.heartbeatIntervalMs` and
closes connections that exceed `websocket.idleTimeoutMs`.
