# Server Configuration

The `server` section controls the HTTP server, authentication, and API access.

## Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `port` | integer | `0` | HTTP server port. `0` = auto-assign available port. |
| `host` | string | `'127.0.0.1'` | Bind address. Use `0.0.0.0` to listen on all interfaces. |
| `shutdownTimeoutMs` | integer | `15000` | Maximum time (ms) for graceful shutdown before force exit. |
| `apiKey` | string | (none) | **Deprecated.** Single API key for admin access. Min 8 characters. |
| `apiKeys` | array | (none) | Role-based API keys. See below. |

## API Keys

The `apiKeys` array defines role-based access control. Each entry has:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `key` | string | Yes | The API key string. Min 8 characters. |
| `role` | string | Yes | One of: `"admin"`, `"observer"` |
| `name` | string | No | Human-readable name for this key. |

### Example

```jsonc
{
  "server": {
    "apiKeys": [
      { "key": "admin-secret-key-12345678", "role": "admin", "name": "Admin" },
      { "key": "observer-secret-key-12345678", "role": "observer", "name": "Observer" }
    ]
  }
}
```

### Authentication Behavior

- If `apiKeys` is empty or not configured, **all requests are allowed** (no auth required)
- If `apiKeys` is configured, every request must include a valid key
- HTTP: `Authorization: Bearer <key>` header
- WebSocket: `?apiKey=<key>` query parameter

### Legacy `apiKey`

The `apiKey` field is deprecated. If both `apiKey` and `apiKeys` are configured, `apiKeys` takes precedence. To migrate:

```jsonc
// Before (deprecated)
{
  "server": {
    "apiKey": "my-secret-key-12345678"
  }
}

// After (recommended)
{
  "server": {
    "apiKeys": [
      { "key": "my-secret-key-12345678", "role": "admin", "name": "Default Admin" }
    ]
  }
}
```

## Environment Variables

| Variable | Overrides |
|----------|-----------|
| `AGENTORCHESTRATOR_SERVER_PORT` | `server.port` |
| `AGENTORCHESTRATOR_SERVER_HOST` | `server.host` |
| `AGENTORCHESTRATOR_SERVER_SHUTDOWN_TIMEOUT_MS` | `server.shutdownTimeoutMs` |
