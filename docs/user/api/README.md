# API Reference

AgentOrchestrator exposes REST and WebSocket APIs for managing conversations, agents, files, and sessions.

## Base URL

```
http://localhost:8080
```

The port is configurable via `server.port` or the `--port` CLI flag.

## Authentication

If `server.apiKeys` is configured, all requests must include a valid API key:

- **HTTP:** `Authorization: Bearer <key>` header
- **WebSocket:** `?apiKey=<key>` query parameter

See [RBAC Guide](../rbac/) for details.

## Response Format

### Success

```json
{
  "id": "conversation-id",
  "status": "running",
  ...
}
```

### Error

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Conversation not found"
  }
}
```

### Common Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `UNAUTHORIZED` | 401 | Missing or invalid API key |
| `FORBIDDEN` | 403 | Insufficient permissions (observer trying to write) |
| `NOT_FOUND` | 404 | Resource not found |
| `VALIDATION_ERROR` | 400 | Invalid request body |
| `WORKSPACE_QUOTA_EXCEEDED` | 413 | Workspace size limit exceeded |
| `INSTANCE_ERROR` | 500 | OpenCode instance error |

## API Sections

| Section | Description |
|---------|-------------|
| [REST API](rest.md) | HTTP endpoints for conversation and resource management |
| [WebSocket API](websocket.md) | JSON-RPC 2.0 methods for real-time communication |
| [SSE Events](events.md) | Server-Sent Events for conversation lifecycle |

## Rate Limiting

Currently no rate limiting is implemented. In production, use a reverse proxy (nginx, Caddy) for rate limiting.
