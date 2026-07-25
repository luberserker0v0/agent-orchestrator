# Deployment

AgentOrchestrator can be deployed via Docker, npm, or from source.

## Method Comparison

| Method | Best For | Complexity | Isolation |
|--------|----------|------------|-----------|
| [Docker](docker.md) | Production, multi-tenant | Low | Container |
| [npm Global](npm.md) | Single server, development | Low | Process |
| Source | Contributing, customization | Medium | Process |

## Quick Deploy

### Docker (Production)

```bash
docker run -d \
  --name agent-orchestrator \
  -p 8080:8080 \
  -v /path/to/config:/app/config \
  -v /path/to/workspace:/app/workspace \
  ghcr.io/anomalyco/opencode:latest
```

### npm Global

```bash
npm install -g agent-orchestrator
aor
```

### Source

```bash
git clone https://github.com/luberserker0v0/agent-orchestrator.git
cd agent-orchestrator
npm install
npm run build
npm start
```

## Config Resolution

Configuration is resolved in this order (first match wins):

1. `--config <path>` CLI argument
2. `./ao.config.json` (current directory)
3. `./config/agentorchestrator.json` (current directory)
4. `./config/agentorchestrator.example.json` (fallback defaults)

Environment variables override config file values. See [Configuration Reference](../configuration/) for all options.

## Production Checklist

- [ ] Configure `server.apiKeys` for authentication
- [ ] Set `server.host` to `0.0.0.0` if exposing externally
- [ ] Use HTTPS via reverse proxy (nginx, Caddy)
- [ ] Set `workspace.maxSizeBytes` appropriately
- [ ] Configure `orchestrator.maxInstances` based on resources
- [ ] Set up Prometheus monitoring (see [Monitoring](../runbook/monitoring.md))
- [ ] Configure log rotation
- [ ] Test graceful shutdown (SIGTERM)

## Graceful Shutdown

On `SIGINT` or `SIGTERM`:

1. Stop idle sweep timer
2. Close all WebSocket connections (code 1001)
3. Stop accepting new HTTP connections
4. Wait for in-flight requests (up to `shutdownTimeoutMs`)
5. Destroy all OpenCode instances
6. Exit cleanly (or force-exit if timeout exceeded)
