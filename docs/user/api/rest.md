# REST API

Application endpoints are prefixed with `/api`. When RBAC is enabled, every
non-public operation requires the explicit permission shown below. Built-in
roles and custom-role assignment are documented in the [RBAC guide](../rbac/).

## Health & Info

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `GET` | `/health` | Public | Health check |
| `GET` | `/metrics` | Public | Prometheus metrics |
| `GET` | `/api-docs` | Public | Swagger UI |
| `GET` | `/api-docs.json` | Public | OpenAPI spec |
| `GET` | `/api/runtimes` | `runtime:list` | List configured runtimes |
| `GET` | `/api/auth/role` | Authenticated | Get current API key role |

## Cleanup

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `POST` | `/api/cleanup/preview` | `cleanup:read` | Fresh, non-mutating scan; body may select unique `targets` (`logs`, `persistentData`) |
| `POST` | `/api/cleanup/run` | `cleanup:run` | Run selected targets; requires `{"targets":[...],"confirm":true}` |

The built-in `admin` wildcard grants both permissions; built-in `user` and
`observer` roles do not. Manual runs cannot override configured paths, retention,
or grace periods. Concurrent operations return `409 CLEANUP_IN_PROGRESS`.
Per-artifact failures are returned as a `200` report with `partial` or `failed`
status. Candidate records never include absolute filesystem paths.

## Conversations

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `POST` | `/api/conversations` | `conversation:start` | Prepare conversation and workspace |
| `GET` | `/api/conversations` | `conversation:list` | List conversations |
| `GET` | `/api/conversations/:id` | `conversation:get` | Get conversation |
| `DELETE` | `/api/conversations/:id` | `conversation:delete` | Delete conversation and managed data |
| `GET` | `/api/conversations/:id/events` | `conversation:events` | Get events (query: `limit`, max 100) |

Client-supplied conversation IDs must contain 1-52 lowercase letters, digits,
or hyphens and must start and end with a letter or digit. Invalid IDs return
`400 INVALID_CONVERSATION_ID` before any workspace or runtime resource is created.

### Conversation Lifecycle

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `POST` | `/api/conversations/:id/start` | `conversation:start` | Start OpenCode instance |
| `POST` | `/api/conversations/:id/stop` | `conversation:stop` | Stop instance and preserve data |
| `POST` | `/api/conversations/:id/restart` | `conversation:restart` | Restart instance and resume session when possible |
| `POST` | `/api/conversations/:id/migrate` | `conversation:migrate` | Move a Kubernetes conversation to body `nodeName` |

## Configuration

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `GET` | `/api/conversations/:id/config` | `config:get` | Read OpenCode config (may contain credentials) |
| `POST` | `/api/conversations/:id/config` | `config:write` | Replace config atomically |
| `PATCH` | `/api/conversations/:id/config` | `config:write` | Patch config (deep merge) |

## Agents

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `GET` | `/api/conversations/:id/agents` | `agent:list` | List agents |
| `GET` | `/api/conversations/:id/agents/:name` | `agent:get` | Read agent content |
| `PUT` | `/api/conversations/:id/agents` | `agent:write` | Write agent (body: `{ name, content }`) |
| `DELETE` | `/api/conversations/:id/agents/:name` | `agent:delete` | Delete agent |

### AGENTS.md

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `GET` | `/api/conversations/:id/agent/config` | `agent:get` | Read AGENTS.md |
| `PUT` | `/api/conversations/:id/agent/config` | `agent:write` | Write AGENTS.md |
| `DELETE` | `/api/conversations/:id/agent/config` | `agent:delete` | Delete AGENTS.md |

## Files

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `POST` | `/api/conversations/:id/files/list` | `file:list` | List files (body: `{ path? }`) |
| `POST` | `/api/conversations/:id/files/read` | `file:read` | Read file (body: `{ path }`) |
| `PUT` | `/api/conversations/:id/files` | `file:write` | Write file (body: `{ path, content }`) |
| `POST` | `/api/conversations/:id/files/delete` | `file:delete` | Delete file (body: `{ path }`) |
| `POST` | `/api/conversations/:id/files/copy` | `file:copy` | Copy approved local source (body: `{ source, dest }`) |

## Sessions

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `GET` | `/api/conversations/:id/sessions` | `session:list` | List sessions |
| `GET` | `/api/conversations/:id/sessions/:sid` | `session:get` | Get session |
| `GET` | `/api/conversations/:id/sessions/:sid/children` | `session:children` | Get session children |
| `GET` | `/api/conversations/:id/sessions/:sid/messages` | `message:history` | Get session messages |
| `POST` | `/api/conversations/:id/sessions` | `session:create` | Create session |
| `POST` | `/api/conversations/:id/sessions/:sid/fork` | `session:fork` | Fork session |
| `DELETE` | `/api/conversations/:id/sessions/:sid` | `session:delete` | Delete session |
| `POST` | `/api/conversations/:id/sessions/abort` | `session:abort` | Abort current session |

## Messages

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `POST` | `/api/conversations/:id/message` | `message:send` | Send message |

### Request Body

```json
{
  "text": "Hello, can you help me with this code?",
  "model": "anthropic/claude-sonnet-4-20250514",
  "agent": "code-reviewer"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | Yes | Message text |
| `model` | string | No | Model to use (provider/model format) |
| `agent` | string | No | Agent to use |

### Response

```json
{
  "messageId": "msg-abc123",
  "text": "I'd be happy to help...",
  "parts": [...]
}
```

## Providers

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `GET` | `/api/conversations/:id/providers` | `provider:list` | List available providers |

## Skills

### Global Skills

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `GET` | `/api/conversations/:id/skills` | `skill:list` | List skills |
| `GET` | `/api/conversations/:id/skills/:name` | `skill:get` | Read skill SKILL.md |
| `GET` | `/api/conversations/:id/skills/:name/info` | `skill:info` | Get skill info (files, size, sha256) |
| `POST` | `/api/conversations/:id/skills/upload` | `skill:import` | Upload skill ZIP (raw body, query: `name`) |
| `POST` | `/api/conversations/:id/skills/import` | `skill:import` | Import approved local skill (body: `{ source, name }`) |
| `DELETE` | `/api/conversations/:id/skills/:name` | `skill:delete` | Delete skill |

### Agent-Scoped Skills

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `GET` | `/api/conversations/:id/agents/:agent/skills` | `skill:list` | List agent skills |
| `GET` | `/api/conversations/:id/agents/:agent/skills/:name` | `skill:get` | Read agent skill |
| `GET` | `/api/conversations/:id/agents/:agent/skills/:name/info` | `skill:info` | Get agent skill info |
| `POST` | `/api/conversations/:id/agents/:agent/skills/upload` | `skill:import` | Upload agent skill ZIP |
| `POST` | `/api/conversations/:id/agents/:agent/skills/import` | `skill:import` | Import approved local agent skill |
| `DELETE` | `/api/conversations/:id/agents/:agent/skills/:name` | `skill:delete` | Delete agent skill |

## Roles

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `GET` | `/api/roles` | `role:read` | List built-in and custom roles |
| `GET` | `/api/roles/:name` | `role:read` | Get one role |
| `POST` | `/api/roles` | `role:write` | Create a custom role |
| `PUT` | `/api/roles/:name` | `role:write` | Replace custom-role permissions |
| `DELETE` | `/api/roles/:name` | `role:write` | Delete a custom role |

Built-in roles are immutable. Role mutations are persisted atomically to the
AO configuration file; a failed write leaves the previous in-memory and on-disk
configuration intact.

## Example: Full Workflow

```bash
# 1. Create conversation
curl -X POST http://localhost:8080/api/conversations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer admin-key" \
  -d '{}'

# 2. Start instance
curl -X POST http://localhost:8080/api/conversations/abc123/start \
  -H "Authorization: Bearer admin-key"

# 3. Send message
curl -X POST http://localhost:8080/api/conversations/abc123/message \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer admin-key" \
  -d '{"text": "Explain this code to me"}'

# 4. Check status
curl http://localhost:8080/api/conversations/abc123 \
  -H "Authorization: Bearer admin-key"

# 5. Clean up
curl -X DELETE http://localhost:8080/api/conversations/abc123 \
  -H "Authorization: Bearer admin-key"
```
