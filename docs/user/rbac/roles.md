# Roles

AgentOrchestrator ships with three built-in roles: `admin`, `user`, and `observer`. You can also create custom roles via the REST API or config file.

## Built-in Roles

### Admin

Full access to all operations, including role management.

**Permissions:** `["*"]` (wildcard — all permissions granted)

**Use for:** Application administrators, automation scripts, trusted clients.

### User

Can perform most operations but cannot manage roles. Suitable for regular users who need to interact with conversations.

**Permissions:**

| Resource | Permissions |
|----------|-------------|
| Conversation | `conversation:start`, `conversation:stop`, `conversation:restart`, `conversation:delete` |
| Message | `message:send` |
| Config | `config:write` |
| Agent | `agent:write`, `agent:delete` |
| File | `file:write`, `file:delete`, `file:copy` |
| Session | `session:create`, `session:delete`, `session:fork`, `session:abort` |
| Skill | `skill:import`, `skill:delete` |

**Use for:** Regular users who need to create and manage conversations.

### Observer

Read-only access. Can view everything but cannot modify anything.

**Permissions:**

| Resource | Permissions |
|----------|-------------|
| Conversation | `conversation:list`, `conversation:get`, `conversation:events` |
| Message | `message:history` |
| Config | `config:get` |
| Agent | `agent:list`, `agent:get` |
| File | `file:read`, `file:list` |
| Session | `session:list`, `session:get`, `session:children` |
| Skill | `skill:list`, `skill:get`, `skill:info` |

**Use for:** Monitoring dashboards, audit logs, read-only integrations.

## Permission Comparison

| Operation | Admin | User | Observer |
|-----------|-------|------|----------|
| **Conversations** | | | |
| Create conversation | Yes | Yes | No |
| Start conversation | Yes | Yes | No |
| Stop conversation | Yes | Yes | No |
| Restart conversation | Yes | Yes | No |
| Delete conversation | Yes | Yes | No |
| List conversations | Yes | Yes | Yes |
| Get conversation | Yes | Yes | Yes |
| Get conversation events | Yes | Yes | Yes |
| **Configuration** | | | |
| Read config | Yes | Yes | Yes |
| Write config | Yes | Yes | No |
| Patch config | Yes | Yes | No |
| **Agents** | | | |
| List agents | Yes | Yes | Yes |
| Read agent | Yes | Yes | Yes |
| Write agent | Yes | Yes | No |
| Delete agent | Yes | Yes | No |
| **Files** | | | |
| List files | Yes | Yes | Yes |
| Read file | Yes | Yes | Yes |
| Write file | Yes | Yes | No |
| Delete file | Yes | Yes | No |
| Copy file | Yes | Yes | No |
| **Sessions** | | | |
| List sessions | Yes | Yes | Yes |
| Get session | Yes | Yes | Yes |
| Create session | Yes | Yes | No |
| Delete session | Yes | Yes | No |
| Fork session | Yes | Yes | No |
| Abort session | Yes | Yes | No |
| **Messages** | | | |
| Send message | Yes | Yes | No |
| Get message history | Yes | Yes | Yes |
| **Skills** | | | |
| List skills | Yes | Yes | Yes |
| Read skill | Yes | Yes | Yes |
| Get skill info | Yes | Yes | Yes |
| Upload skill | Yes | Yes | No |
| Import skill | Yes | Yes | No |
| Delete skill | Yes | Yes | No |
| **Roles** | | | |
| List roles | Yes | Yes | Yes |
| Create role | Yes | No | No |
| Update role | Yes | No | No |
| Delete role | Yes | No | No |

## Custom Roles

You can create custom roles via the REST API or config file. Custom roles have arbitrary permission sets.

### REST API

```bash
# Create a custom role
curl -X POST http://localhost:8080/api/roles \
  -H "Authorization: Bearer admin-key" \
  -H "Content-Type: application/json" \
  -d '{"name": "deployer", "permissions": ["conversation:start", "conversation:stop", "message:send"]}'

# Update a role
curl -X PUT http://localhost:8080/api/roles/deployer \
  -H "Authorization: Bearer admin-key" \
  -H "Content-Type: application/json" \
  -d '{"permissions": ["conversation:start", "conversation:stop", "conversation:restart", "message:send"]}'

# Delete a role
curl -X DELETE http://localhost:8080/api/roles/deployer \
  -H "Authorization: Bearer admin-key"
```

### Config File

Define custom roles in the `roles` section of your config:

```jsonc
{
  "roles": {
    "deployer": {
      "permissions": [
        "conversation:start",
        "conversation:stop",
        "conversation:restart",
        "message:send"
      ]
    }
  }
}
```

**Notes:**
- Role names must start with a letter and contain only alphanumeric, hyphen, or underscore characters (max 64 characters)
- The `admin` role cannot be modified or deleted
- Built-in roles (`admin`, `user`, `observer`) cannot be overridden
- Custom roles are persisted to the config file automatically
