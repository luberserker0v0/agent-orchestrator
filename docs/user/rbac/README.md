# Role-Based Access Control (RBAC)

AgentOrchestrator implements role-based access control to restrict API access based on API key roles.

## Overview

RBAC is **optional**. If no `apiKeys` are configured, all requests are allowed without authentication.

When `apiKeys` is configured, every request must include a valid API key. The key's role determines what operations are permitted.

## Built-in Roles

| Role | Access Level | Description |
|------|-------------|-------------|
| `admin` | Full | Can perform all operations (read, write, delete) |
| `user` | Write + Read | Can start conversations, send messages, manage files and sessions; cannot manage roles |
| `observer` | Read-only | Can view conversations, agents, files, sessions; cannot modify |

## Permission Model

Permissions are enforced at two levels:

1. **HTTP middleware** — Non-GET routes require appropriate permission based on role
2. **WebSocket router** — Write methods require appropriate permission based on role

Permissions use the format `resource:action` (e.g. `conversation:start`, `message:send`). The `admin` role uses `["*"]` to grant all permissions.

### What Admin Can Do

- Everything (wildcard `["*"]`)
- Manage roles (create, update, delete custom roles)

### What User Can Do

- Start, stop, restart, delete conversations
- Send messages
- Write config, agents, files, sessions
- Import and delete skills

### What Observer Can Do

- List and view conversations
- Read config, agents, files, sessions
- View message history
- View skills
- **Cannot** modify anything

## Configuration

See [API Keys](api-keys.md) for how to configure `apiKeys` in your config file.

See [Roles](roles.md) for details on built-in and custom roles.

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
| Insufficient permissions | 403 | `FORBIDDEN` |

Example error:
```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "Insufficient permissions"
  }
}
```
