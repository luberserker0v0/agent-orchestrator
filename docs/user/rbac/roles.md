# Roles

AgentOrchestrator ships with two built-in roles. Custom roles with fine-grained permissions are planned.

## Built-in Roles

### Admin

Full access to all operations.

**Permissions:**
- Create, start, stop, restart, delete conversations
- Read and write OpenCode configuration
- Create, read, delete agents and AGENTS.md
- Read, write, delete, copy files
- Create, delete, fork sessions
- Send messages
- Upload, import, delete skills
- List providers

**Use for:** Application administrators, automation scripts, trusted clients.

### Observer

Read-only access. Can view everything but cannot modify anything.

**Permissions:**
- List and view conversations
- View conversation events
- Read OpenCode configuration
- List and read agents and AGENTS.md
- Read and list files
- List and view sessions
- View message history
- List and read skills
- List providers
- View conversation status

**Use for:** Monitoring dashboards, audit logs, read-only integrations.

## Permission Comparison

| Operation | Admin | Observer |
|-----------|-------|----------|
| **Conversations** | | |
| Create conversation | Yes | No |
| Start conversation | Yes | No |
| Stop conversation | Yes | No |
| Restart conversation | Yes | No |
| Delete conversation | Yes | No |
| List conversations | Yes | Yes |
| Get conversation | Yes | Yes |
| Get conversation events | Yes | Yes |
| **Configuration** | | |
| Read config | Yes | Yes |
| Write config | Yes | No |
| Patch config | Yes | No |
| **Agents** | | |
| List agents | Yes | Yes |
| Read agent | Yes | Yes |
| Write agent | Yes | No |
| Delete agent | Yes | No |
| Read AGENTS.md | Yes | Yes |
| Write AGENTS.md | Yes | No |
| Delete AGENTS.md | Yes | No |
| **Files** | | |
| List files | Yes | Yes |
| Read file | Yes | Yes |
| Write file | Yes | No |
| Delete file | Yes | No |
| Copy file | Yes | No |
| **Sessions** | | |
| List sessions | Yes | Yes |
| Get session | Yes | Yes |
| Create session | Yes | No |
| Delete session | Yes | No |
| Fork session | Yes | No |
| Abort session | Yes | No |
| **Messages** | | |
| Send message | Yes | No |
| Get message history | Yes | Yes |
| **Skills** | | |
| List skills | Yes | Yes |
| Read skill | Yes | Yes |
| Get skill info | Yes | Yes |
| Upload skill | Yes | No |
| Import skill | Yes | No |
| Delete skill | Yes | No |
| **Providers** | | |
| List providers | Yes | Yes |

## Future: Fine-Grained Permissions

A planned `user` role will support granular permissions like:

```jsonc
{
  "roles": {
    "user": {
      "permissions": [
        "conversation:create",
        "conversation:start",
        "conversation:stop",
        "message:send",
        "config:read",
        "file:read",
        "file:write",
        "session:create"
      ]
    }
  }
}
```

This is **not yet implemented**. Currently only `admin` and `observer` are supported.
