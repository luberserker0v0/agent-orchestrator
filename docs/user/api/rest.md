# REST API

All endpoints are prefixed with `/api`. Authentication is required if `server.apiKeys` is configured.

## Health & Info

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | No | Health check |
| `GET` | `/metrics` | No | Prometheus metrics |
| `GET` | `/api-docs` | No | Swagger UI |
| `GET` | `/api-docs.json` | No | OpenAPI spec |
| `GET` | `/api/runtimes` | Yes | List configured runtimes |
| `GET` | `/api/auth/role` | Yes | Get current API key role |

## Conversations

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/conversations` | Admin | Create conversation |
| `GET` | `/api/conversations` | Yes | List conversations |
| `GET` | `/api/conversations/:id` | Yes | Get conversation |
| `DELETE` | `/api/conversations/:id` | Admin | Delete conversation |
| `GET` | `/api/conversations/:id/events` | Yes | Get events (query: `limit`, max 100) |

### Conversation Lifecycle

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/conversations/:id/start` | Admin | Start OpenCode instance |
| `POST` | `/api/conversations/:id/stop` | Admin | Stop instance |
| `POST` | `/api/conversations/:id/restart` | Admin | Restart instance |

## Configuration

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/conversations/:id/config` | Yes | Read OpenCode config |
| `POST` | `/api/conversations/:id/config` | Admin | Write config |
| `PATCH` | `/api/conversations/:id/config` | Admin | Patch config (deep merge) |

## Agents

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/conversations/:id/agents` | Yes | List agents |
| `GET` | `/api/conversations/:id/agents/:name` | Yes | Read agent content |
| `PUT` | `/api/conversations/:id/agents` | Admin | Write agent (body: `{ name, content }`) |
| `DELETE` | `/api/conversations/:id/agents/:name` | Admin | Delete agent |

### AGENTS.md

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/conversations/:id/agent/config` | Yes | Read AGENTS.md |
| `PUT` | `/api/conversations/:id/agent/config` | Admin | Write AGENTS.md |
| `DELETE` | `/api/conversations/:id/agent/config` | Admin | Delete AGENTS.md |

## Files

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/conversations/:id/files/list` | Yes | List files (body: `{ path? }`) |
| `POST` | `/api/conversations/:id/files/read` | Yes | Read file (body: `{ path }`) |
| `PUT` | `/api/conversations/:id/files` | Admin | Write file (body: `{ path, content }`) |
| `POST` | `/api/conversations/:id/files/delete` | Admin | Delete file (body: `{ path }`) |
| `POST` | `/api/conversations/:id/files/copy` | Admin | Copy file (body: `{ source, dest }`) |

## Sessions

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/conversations/:id/sessions` | Yes | List sessions |
| `GET` | `/api/conversations/:id/sessions/:sid` | Yes | Get session |
| `GET` | `/api/conversations/:id/sessions/:sid/children` | Yes | Get session children |
| `GET` | `/api/conversations/:id/sessions/:sid/messages` | Yes | Get session messages |
| `POST` | `/api/conversations/:id/sessions` | Admin | Create session |
| `POST` | `/api/conversations/:id/sessions/:sid/fork` | Admin | Fork session |
| `DELETE` | `/api/conversations/:id/sessions/:sid` | Admin | Delete session |
| `POST` | `/api/conversations/:id/sessions/abort` | Admin | Abort current session |

## Messages

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/conversations/:id/message` | Admin | Send message |

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

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/conversations/:id/providers` | Yes | List available providers |

## Skills

### Global Skills

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/conversations/:id/skills` | Yes | List skills |
| `GET` | `/api/conversations/:id/skills/:name` | Yes | Read skill SKILL.md |
| `GET` | `/api/conversations/:id/skills/:name/info` | Yes | Get skill info (files, size, sha256) |
| `POST` | `/api/conversations/:id/skills/upload` | Admin | Upload skill (multipart, query: `name`) |
| `POST` | `/api/conversations/:id/skills/import` | Admin | Import skill (body: `{ source, name }`) |
| `DELETE` | `/api/conversations/:id/skills/:name` | Admin | Delete skill |

### Agent-Scoped Skills

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/conversations/:id/agents/:agent/skills` | Yes | List agent skills |
| `GET` | `/api/conversations/:id/agents/:agent/skills/:name` | Yes | Read agent skill |
| `GET` | `/api/conversations/:id/agents/:agent/skills/:name/info` | Yes | Get agent skill info |
| `POST` | `/api/conversations/:id/agents/:agent/skills/upload` | Admin | Upload agent skill |
| `POST` | `/api/conversations/:id/agents/:agent/skills/import` | Admin | Import agent skill |
| `DELETE` | `/api/conversations/:id/agents/:agent/skills/:name` | Admin | Delete agent skill |

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
