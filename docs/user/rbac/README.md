# Role-Based Access Control (RBAC)

AgentOrchestrator implements role-based access control to restrict API access based on API key roles.

## Overview

RBAC is **optional**. If no `apiKeys` are configured, all requests are allowed without authentication.

When `apiKeys` is configured, every request must include a valid API key. The key's role determines what operations are permitted.

## Built-in Roles

| Role | Access Level | Description |
|------|-------------|-------------|
| `admin` | Full | Can perform all operations (read, write, delete) |
| `observer` | Read-only | Can view conversations, agents, files, sessions; cannot modify |

**Note:** A `user` role with fine-grained permissions (e.g., `conversation:start`, `message:send`) is planned but not yet implemented.

## Permission Model

Permissions are enforced at two levels:

1. **HTTP middleware** — Non-GET routes require `admin` role
2. **WebSocket router** — Write methods require `admin` role

### What Admin Can Do

- Create, start, stop, restart, delete conversations
- Read and write config, agents, files, sessions
- Send messages
- Upload and delete skills
- View all conversations (same as observer)

### What Observer Can Do

- List and view conversations
- Read config, agents, files, sessions
- View message history
- View skills
- **Cannot** modify anything

## Configuration

See [API Keys](api-keys.md) for how to configure `apiKeys` in your config file.

## Checking Your Role

```bash
# Check current API key's role
curl -H "Authorization: Bearer your-api-key" http://localhost:8080/api/auth/role
```

Response:
```json
{
  "role": "admin",
  "name": "Admin"
}
```

## Error Responses

| Scenario | HTTP Status | Error Code |
|----------|-------------|------------|
| Missing API key (when required) | 401 | `UNAUTHORIZED` |
| Invalid API key | 401 | `UNAUTHORIZED` |
| Observer trying to write | 403 | `FORBIDDEN` |

Example error:
```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "Write operations require admin role"
  }
}
```
