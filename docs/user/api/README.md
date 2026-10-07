# API Reference

AgentOrchestrator exposes REST and WebSocket APIs for managing conversations, agents, files, and sessions.

## Base URL

```
http://localhost:8080
```

The port is configurable via `server.port` or the `--port` CLI flag.

## Authentication

When RBAC is enabled, non-public requests must include a valid API key and the
key's role must grant the operation's explicit permission:

- **HTTP:** `Authorization: Bearer <key>` header
- **WebSocket:** `?apiKey=<key>` query parameter

RBAC can be explicitly enabled or disabled with `server.rbac.enabled`; when it
is omitted, configured `apiKeys` enable RBAC automatically. See the
[RBAC Guide](../rbac/) for details.

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
| `CONVERSATION_NOT_FOUND` and resource-specific codes | 404 | Resource not found |
| `INVALID_REQUEST_BODY`, `MISSING_FIELD` | 400 | Invalid request body |
| `WORKSPACE_QUOTA_EXCEEDED` | 413 | Workspace size limit exceeded |
| `CLEANUP_IN_PROGRESS` | 409 | Another cleanup operation owns the single-flight gate |
| `PERSISTENT_DATA_CLEANUP_PENDING` | 500 | Safe deletion could not complete and requires retry |

## API Sections

| Section | Description |
|---------|-------------|
| [REST API](rest.md) | HTTP endpoints for conversation and resource management |
| [WebSocket API](websocket.md) | JSON-RPC 2.0 methods for real-time communication |
| [SSE Events](events.md) | Server-Sent Events for conversation lifecycle |

## Rate Limiting

Currently no rate limiting is implemented. In production, use a reverse proxy (nginx, Caddy) for rate limiting.
