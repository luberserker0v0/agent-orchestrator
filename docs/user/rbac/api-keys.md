# API Keys

API keys control access to AgentOrchestrator's REST and WebSocket APIs.

## Configuration

Add API keys to your config file under `server.apiKeys`:

```jsonc
{
  "server": {
    "apiKeys": [
      { "key": "admin-secret-key-12345678", "role": "admin", "name": "Admin" },
      { "key": "user-secret-key-12345678", "role": "user", "name": "User" },
      { "key": "observer-secret-key-12345678", "role": "observer", "name": "Observer" }
    ]
  }
}
```

## Key Entry Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `key` | string | Yes | The API key string. Minimum 8 characters. |
| `role` | string | Yes | Role: `"admin"`, `"user"`, or `"observer"`. |
| `name` | string | No | Human-readable label for this key. |

## Authentication Methods

### HTTP Requests

Include the API key in the `Authorization` header:

```bash
curl -H "Authorization: Bearer admin-secret-key-12345678" \
  http://localhost:8080/api/conversations
```

### WebSocket Connections

Include the API key as a query parameter:

```bash
wscat -c "ws://localhost:8080/ws/conversation-id?apiKey=admin-secret-key-12345678"
```

**Note:** WebSocket upgrade requests do not support custom headers, so the query parameter is the only method for WebSocket auth.

### Dashboard

The dashboard authenticates via the same query parameter mechanism. When you open the dashboard, it stores the API key in `sessionStorage` and includes it in WebSocket connections and API requests.

## Behavior When Not Configured

If `server.apiKeys` is empty or not present in the config:

- **All requests are allowed** without authentication
- **No role checks** are performed
- This is the default behavior for quick setup and development

## Legacy `apiKey` (Deprecated)

The single `server.apiKey` field is deprecated:

```jsonc
{
  "server": {
    "apiKey": "my-secret-key-12345678"  // DEPRECATED
  }
}
```

If both `apiKey` and `apiKeys` are configured, `apiKeys` takes precedence. To migrate:

1. Add the key to `apiKeys` array with role `"admin"`
2. Remove the `apiKey` field

## Generating Secure Keys

```bash
# Generate a random 32-character key
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"

# Or using openssl
openssl rand -hex 24
```

## Security Best Practices

1. **Use strong keys** — At least 16 characters, randomly generated
2. **Separate roles** — Use different keys for admin, user, and observer
3. **Rotate regularly** — Change keys periodically
4. **Use HTTPS** — In production, always use TLS
5. **Don't log keys** — Never include keys in logs or error messages
6. **Limit observer access** — Give observer keys to monitoring tools only
7. **Use user role** — Give user keys to regular users who need write access
