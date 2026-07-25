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

AgentOrchestrator implements role-based access control with two built-in roles.

### Roles

| Role | Permissions | Description |
|------|-------------|-------------|
| `admin` | `["*"]` | Full access to all endpoints, including mutation |
| `observer` | Read-only | Can view conversations, agents, files, sessions; cannot modify |

**Note:** A `user` role with fine-grained permissions is planned but not yet implemented.

### Permission Matrix

#### HTTP Endpoints

| Endpoint | Admin | Observer |
|----------|-------|----------|
| `GET /health` | Yes | Yes |
| `GET /metrics` | Yes | Yes |
| `GET /api/runtimes` | Yes | Yes |
| `GET /api/auth/role` | Yes | Yes |
| `GET /api/conversations` | Yes | Yes |
| `GET /api/conversations/:id` | Yes | Yes |
| `GET /api/conversations/:id/events` | Yes | Yes |
| `POST /api/conversations` | Yes | No |
| `POST /api/conversations/:id/start` | Yes | No |
| `POST /api/conversations/:id/stop` | Yes | No |
| `POST /api/conversations/:id/restart` | Yes | No |
| `DELETE /api/conversations/:id` | Yes | No |
| `GET /api/conversations/:id/config` | Yes | Yes |
| `POST /api/conversations/:id/config` | Yes | No |
| `PATCH /api/conversations/:id/config` | Yes | No |
| `PUT /api/conversations/:id/agents` | Yes | No |
| `GET /api/conversations/:id/agents` | Yes | Yes |
| `GET /api/conversations/:id/agents/:name` | Yes | Yes |
| `DELETE /api/conversations/:id/agents/:name` | Yes | No |
| `PUT /api/conversations/:id/files` | Yes | No |
| `POST /api/conversations/:id/files/read` | Yes | Yes |
| `POST /api/conversations/:id/files/delete` | Yes | No |
| `POST /api/conversations/:id/files/copy` | Yes | No |
| `POST /api/conversations/:id/files/list` | Yes | Yes |
| `POST /api/conversations/:id/sessions` | Yes | No |
| `GET /api/conversations/:id/sessions` | Yes | Yes |
| `GET /api/conversations/:id/sessions/:sid` | Yes | Yes |
| `DELETE /api/conversations/:id/sessions/:sid` | Yes | No |
| `POST /api/conversations/:id/message` | Yes | No |
| `POST /api/conversations/:id/skills/upload` | Yes | No |
| `POST /api/conversations/:id/skills/import` | Yes | No |
| `GET /api/conversations/:id/skills` | Yes | Yes |
| `GET /api/conversations/:id/skills/:name` | Yes | Yes |
| `DELETE /api/conversations/:id/skills/:name` | Yes | No |

#### WebSocket Methods

| Method | Admin | Observer |
|--------|-------|----------|
| `message.history` | Yes | Yes |
| `config.get` | Yes | Yes |
| `agent.list` | Yes | Yes |
| `agent.get` | Yes | Yes |
| `agent.config.get` | Yes | Yes |
| `file.read` | Yes | Yes |
| `file.list` | Yes | Yes |
| `session.list` | Yes | Yes |
| `session.get` | Yes | Yes |
| `session.children` | Yes | Yes |
| `providers.list` | Yes | Yes |
| `skills.list` | Yes | Yes |
| `skills.get` | Yes | Yes |
| `skills.info` | Yes | Yes |
| `conversation.status` | Yes | Yes |
| `message.send` | Yes | No |
| `config.update` | Yes | No |
| `config.patch` | Yes | No |
| `agent.register` | Yes | No |
| `agent.delete` | Yes | No |
| `agent.config.write` | Yes | No |
| `agent.config.delete` | Yes | No |
| `file.write` | Yes | No |
| `file.delete` | Yes | No |
| `file.copy` | Yes | No |
| `session.create` | Yes | No |
| `session.delete` | Yes | No |
| `session.fork` | Yes | No |
| `session.abort` | Yes | No |
| `skills.import` | Yes | No |
| `skills.delete` | Yes | No |
| `conversation.start` | Yes | No |
| `conversation.stop` | Yes | No |
| `conversation.restart` | Yes | No |
| `conversation.delete` | Yes | No |

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
