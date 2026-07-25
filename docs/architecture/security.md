# Security Design

AgentOrchestrator implements defense-in-depth with multiple security layers.

## Authentication Layers

The system has three independent authentication layers:

### Layer 1: AgentOrchestrator API Authentication

Controls access to the AO REST and WebSocket APIs.

| Mechanism | Transport | Configuration |
|-----------|-----------|---------------|
| Bearer token | HTTP `Authorization: Bearer <key>` header | `server.apiKeys[]` |
| Query param | WebSocket `?apiKey=<key>` | `server.apiKeys[]` |
| Legacy token | HTTP `Authorization: Bearer <key>` header | `server.apiKey` (deprecated) |

**Behavior:**
- If `server.apiKeys` is empty or not configured, **all requests are allowed** (backward compatibility)
- If `server.apiKeys` is configured, every request must include a valid key
- WebSocket connections authenticate during the HTTP upgrade via query param or header

### Layer 2: OpenCode Instance Authentication

Protects communication between AO and the spawned OpenCode instances.

| Mechanism | Configuration |
|-----------|---------------|
| Server password | `OPENCODE_SERVER_PASSWORD` env var (auto-generated per instance) |

**Behavior:**
- Each OpenCode instance gets a unique, ephemeral password generated at spawn time
- The password is never written to disk
- AO uses this password to authenticate HTTP requests to the OpenCode API
- The password is separate from the AO API key

### Layer 3: LLM Provider Authentication

Protects communication between OpenCode and AI providers.

| Mechanism | Configuration |
|-----------|---------------|
| Provider API key | `apiKey` field in `opencode.json` per provider |

**Behavior:**
- Each provider (Anthropic, OpenAI, etc.) requires its own API key
- Keys are stored in the conversation-specific `opencode.json`
- AO copies this config to the workspace at conversation start
- Keys are never logged or exposed via API

## Authorization (RBAC)

AgentOrchestrator implements role-based access control with three built-in roles. RBAC is **optional** — if no `apiKeys` are configured, all requests are allowed without authentication.

### Roles

| Role | Permissions | Description |
|------|-------------|-------------|
| `admin` | `["*"]` | Full access to all endpoints, including role management |
| `user` | 16 write permissions | Can start conversations, send messages, manage files and sessions |
| `observer` | 13 read permissions | Can view conversations, agents, files, sessions; cannot modify |

Custom roles can be created via the REST API or config file. See [RBAC Guide](../user/rbac/) for details.

### Permission Format

Permissions use the format `resource:action` (e.g. `conversation:start`, `message:send`). The `admin` role uses `["*"]` to grant all permissions.

### HTTP Permission Matrix

| Endpoint | Permission | Admin | User | Observer |
|----------|-----------|-------|------|----------|
| `GET *` | (none) | Yes | Yes | Yes |
| `POST /api/conversations` | `conversation:start` | Yes | Yes | No |
| `POST /api/conversations/:id/start` | `conversation:start` | Yes | Yes | No |
| `POST /api/conversations/:id/stop` | `conversation:stop` | Yes | Yes | No |
| `POST /api/conversations/:id/restart` | `conversation:restart` | Yes | Yes | No |
| `DELETE /api/conversations/:id` | `conversation:delete` | Yes | Yes | No |
| `POST /api/conversations/:id/config` | `config:write` | Yes | Yes | No |
| `PUT /api/conversations/:id/agents` | `agent:write` | Yes | Yes | No |
| `DELETE /api/conversations/:id/agents/:name` | `agent:delete` | Yes | Yes | No |
| `PUT /api/conversations/:id/files` | `file:write` | Yes | Yes | No |
| `POST /api/conversations/:id/files/delete` | `file:delete` | Yes | Yes | No |
| `POST /api/conversations/:id/files/copy` | `file:copy` | Yes | Yes | No |
| `POST /api/conversations/:id/sessions` | `session:create` | Yes | Yes | No |
| `DELETE /api/conversations/:id/sessions/:sid` | `session:delete` | Yes | Yes | No |
| `POST /api/conversations/:id/sessions/:sid/fork` | `session:fork` | Yes | Yes | No |
| `POST /api/conversations/:id/sessions/abort` | `session:abort` | Yes | Yes | No |
| `POST /api/conversations/:id/skills/import` | `skill:import` | Yes | Yes | No |
| `POST /api/conversations/:id/skills/upload` | `skill:import` | Yes | Yes | No |
| `DELETE /api/conversations/:id/skills/:name` | `skill:delete` | Yes | Yes | No |
| `POST /api/roles` | `role:write` | Yes | No | No |
| `PUT /api/roles/:name` | `role:write` | Yes | No | No |
| `DELETE /api/roles/:name` | `role:write` | Yes | No | No |

### WebSocket Permission Matrix

| Method | Permission | Admin | User | Observer |
|--------|-----------|-------|------|----------|
| `message.send` | `message:send` | Yes | Yes | No |
| `config.update` | `config:write` | Yes | Yes | No |
| `config.patch` | `config:write` | Yes | Yes | No |
| `agent.register` | `agent:write` | Yes | Yes | No |
| `agent.delete` | `agent:delete` | Yes | Yes | No |
| `agent.config.write` | `agent:write` | Yes | Yes | No |
| `agent.config.delete` | `agent:delete` | Yes | Yes | No |
| `file.write` | `file:write` | Yes | Yes | No |
| `file.delete` | `file:delete` | Yes | Yes | No |
| `file.copy` | `file:copy` | Yes | Yes | No |
| `session.create` | `session:create` | Yes | Yes | No |
| `session.delete` | `session:delete` | Yes | Yes | No |
| `session.fork` | `session:fork` | Yes | Yes | No |
| `session.abort` | `session:abort` | Yes | Yes | No |
| `skills.import` | `skill:import` | Yes | Yes | No |
| `skills.delete` | `skill:delete` | Yes | Yes | No |
| `conversation.start` | `conversation:start` | Yes | Yes | No |
| `conversation.stop` | `conversation:stop` | Yes | Yes | No |
| `conversation.restart` | `conversation:restart` | Yes | Yes | No |
| `conversation.delete` | `conversation:delete` | Yes | Yes | No |
| `message.history` | (none) | Yes | Yes | Yes |
| `config.get` | (none) | Yes | Yes | Yes |
| `agent.list` | (none) | Yes | Yes | Yes |
| `agent.get` | (none) | Yes | Yes | Yes |
| `agent.config.get` | (none) | Yes | Yes | Yes |
| `file.read` | (none) | Yes | Yes | Yes |
| `file.list` | (none) | Yes | Yes | Yes |
| `session.list` | (none) | Yes | Yes | Yes |
| `session.get` | (none) | Yes | Yes | Yes |
| `session.children` | (none) | Yes | Yes | Yes |
| `providers.list` | (none) | Yes | Yes | Yes |
| `skills.list` | (none) | Yes | Yes | Yes |
| `skills.get` | (none) | Yes | Yes | Yes |
| `skills.info` | (none) | Yes | Yes | Yes |
| `conversation.status` | (none) | Yes | Yes | Yes |

### Public Paths

The following paths are always accessible without authentication:

- `GET /health` — Health check
- `GET /metrics` — Prometheus metrics
- `GET /api-docs` — Swagger UI
- `GET /api-docs.json` — OpenAPI spec
- `GET /dashboard` — Dashboard HTML
- `GET /dashboard/` — Dashboard HTML (trailing slash)

## Security Headers

The HTTP server adds the following security headers:

| Header | Value | Purpose |
|--------|-------|---------|
| `X-Content-Type-Options` | `nosniff` | Prevent MIME type sniffing |
| `X-Frame-Options` | `DENY` | Prevent clickjacking |
| `X-DNS-Prefetch-Control` | `off` | Prevent DNS prefetching |

## CORS Policy

| Setting | Value |
|---------|-------|
| Origins | `*` (all) |
| Methods | `GET, POST, DELETE, PATCH, OPTIONS` |
| Headers | `Content-Type, Authorization` |

## Additional Security Measures

1. **Path traversal protection** — `FileService` validates all file paths against the workspace root
2. **Workspace size quota** — Configurable limit per workspace (`workspace.maxSizeBytes`)
3. **Conversation ID validation** — Only alphanumeric and hyphen characters allowed
4. **Request size limits** — JSON body: 10MB, text body: 5MB
5. **No secrets in logs** — API keys, passwords, and tokens are never logged
6. **Ephemeral passwords** — OpenCode instance passwords are generated per spawn, never persisted
7. **Graceful shutdown** — On SIGINT/SIGTERM, the system stops accepting new connections, waits for in-flight requests, then destroys all instances
8. **WebSocket connection limits** — One connection per conversation; new connections replace existing ones
