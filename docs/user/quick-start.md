# Quick Start

Get a running OpenCode instance in 5 minutes.

## 1. Start AgentOrchestrator

```bash
# Development mode
npm run dev

# Or production mode
npm run build && npm start
```

The server starts on port 8080 (or the next available port if `port: 0`).

## 2. Create a Conversation

```bash
curl -X POST http://localhost:8080/api/conversations \
  -H "Content-Type: application/json" \
  -d '{}'
```

Response:
```json
{
  "id": "abc123",
  "agentType": "opencode-direct",
  "status": "prepared",
  "ready": false,
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

## 3. Start the Instance

```bash
curl -X POST http://localhost:8080/api/conversations/abc123/start
```

Wait for status to become `running`:
```bash
curl http://localhost:8080/api/conversations/abc123
```

## 4. Send a Message

```bash
curl -X POST http://localhost:8080/api/conversations/abc123/message \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, what can you help me with?"}'
```

## 5. Clean Up

```bash
curl -X DELETE http://localhost:8080/api/conversations/abc123
```

## With Authentication

If `server.apiKeys` is configured, include the API key in requests:

```bash
curl -X POST http://localhost:8080/api/conversations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key-here" \
  -d '{}'
```

## WebSocket Connection

Connect to the WebSocket for real-time events:

```bash
# Install wscat if needed
npm install -g wscat

# Connect
wscat -c "ws://localhost:8080/ws/abc123?apiKey=your-api-key"

# Send a message
> {"jsonrpc":"2.0","id":1,"method":"message.send","params":{"text":"Hello"}}
```

## Dashboard

Open the dashboard in your browser:

```
http://localhost:8080/dashboard
```

The dashboard provides a UI for managing conversations, viewing events, and sending messages.

## Next Steps

- [Configuration Reference](configuration/) — All config options
- [API Reference](api/) — REST and WebSocket endpoints
- [RBAC Guide](rbac/) — Authentication and authorization
- [Deployment Guide](deployment/) — Docker, npm, and production setup
