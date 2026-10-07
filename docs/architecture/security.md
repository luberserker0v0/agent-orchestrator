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
- `server.rbac.enabled: true` requires configured API keys and enforces authentication and permissions.
- `server.rbac.enabled: false` disables API authentication explicitly.
- If `server.rbac.enabled` is omitted, RBAC is enabled when `server.apiKeys` is present and disabled otherwise for backward compatibility.
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
- Provider credentials may be supplied through the conversation-specific
  OpenCode configuration or provider-supported environment mechanisms.
- Configuration is stored in the managed workspace and can be read only by a
  caller with `config:get`; treat that permission as secret-bearing access.
- Configuration contents and credentials are excluded from logs, cleanup
  reports, CLI installation inventories, and Kubernetes command summaries.

## Authorization (RBAC)

AgentOrchestrator implements role-based access control with three immutable
built-in roles and configurable custom roles. RBAC behavior follows
`server.rbac.enabled` and the backward-compatible auto-enable rule above.

### Roles

| Role | Permissions | Description |
|------|-------------|-------------|
| `admin` | `["*"]` | Full access to all endpoints, including role management |
| `user` | Operational read/write permissions | Can operate conversations, send messages, and manage files, sessions, agents, and skills; cannot migrate, manage roles, or run cleanup |
| `observer` | Read permissions | Can inspect explicitly permitted runtime, role, conversation, message, config, agent, file, session, provider, and skill data |

Custom roles can be created via the REST API or config file. See [RBAC Guide](../user/rbac/) for details.

### Permission Format

Permissions use the format `resource:action` (e.g. `conversation:start`, `message:send`). The `admin` role uses `["*"]` to grant all permissions.

### HTTP Permission Matrix

| Endpoint | Permission | Admin | User | Observer |
|----------|-----------|-------|------|----------|
| `POST /api/conversations` | `conversation:start` | Yes | Yes | No |
| `POST /api/conversations/:id/start` | `conversation:start` | Yes | Yes | No |
| `POST /api/conversations/:id/stop` | `conversation:stop` | Yes | Yes | No |
| `POST /api/conversations/:id/restart` | `conversation:restart` | Yes | Yes | No |
| `POST /api/conversations/:id/migrate` | `conversation:migrate` | Yes | No | No |
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
| `POST /api/cleanup/preview` | `cleanup:read` | Yes | No | No |
| `POST /api/cleanup/run` | `cleanup:run` | Yes | No | No |

The table emphasizes mutations and privileged operations. Read endpoints are
not implicitly allowed: each maps to its corresponding permission such as
`conversation:get`, `file:read`, `session:list`, or `role:read`. See the
[REST reference](../user/api/rest.md) for the complete route mapping.

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
| `message.history` | `message:history` | Yes | Yes | Yes |
| `config.get` | `config:get` | Yes | Yes | Yes |
| `agent.list` | `agent:list` | Yes | Yes | Yes |
| `agent.get` | `agent:get` | Yes | Yes | Yes |
| `agent.config.get` | `agent:get` | Yes | Yes | Yes |
| `file.read` | `file:read` | Yes | Yes | Yes |
| `file.list` | `file:list` | Yes | Yes | Yes |
| `session.list` | `session:list` | Yes | Yes | Yes |
| `session.get` | `session:get` | Yes | Yes | Yes |
| `session.children` | `session:children` | Yes | Yes | Yes |
| `providers.list` | `provider:list` | Yes | Yes | Yes |
| `skills.list` | `skill:list` | Yes | Yes | Yes |
| `skills.get` | `skill:get` | Yes | Yes | Yes |
| `skills.info` | `skill:info` | Yes | Yes | Yes |
| `conversation.status` | `conversation:get` | Yes | Yes | Yes |

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
9. **Owned cleanup only** — Orphan reaping requires a stable owner ID, two observations, a full grace period, and a final ownership/liveness check
10. **Constrained file logging** — Files use restrictive permissions; filesystem roots, symlink destinations, and unrelated filenames are never pruned

## CLI Credential and Kubernetes Safety

- Operational CLI authentication uses `--api-key-file` or `AOR_API_KEY`; keys are
  sent only as bearer headers and are redacted from errors and output.
- `aor k8s` never records configuration contents, API keys, or Secret data in
  installation inventory or command summaries.
- External configuration Secrets are read only for validation and ownership
  metadata; they are never adopted, changed, rendered, or deleted.
- Kubernetes mutation requires the matching installation labels. Same-name
  foreign resources fail closed, and legacy adoption requires `--confirm`.
- Normal uninstall preserves all persistent state. Purge requires a separate
  flag, confirmation, current ownership checks, Pod-reference checks, and UID
  preconditions.
