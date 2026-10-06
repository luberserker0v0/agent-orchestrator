# Deployment

AgentOrchestrator can be deployed as a direct host process, a Docker container,
or a Kubernetes installation. For first-time installation, use the complete
[setup tutorials](../setup/) before the operational references in this section.

## Method Comparison

| Method | Best For | Complexity | Isolation |
|--------|----------|------------|-----------|
| [Docker](../setup/docker.md) | Single-host production | Low | Container |
| [Direct host](../setup/direct.md) | Single server, development | Low | Process |
| [Kubernetes](../setup/kubernetes.md) | Cluster deployment | Medium | Pod + PVC |
| Source | Contributing, customization | Medium | Process |

## Quick Deploy

### Docker (Production)

Use the AgentOrchestrator image—not the OpenCode runtime image—and mount a
validated configuration plus durable workspace/session volumes. Follow the
[Docker end-to-end setup](../setup/docker.md).

### npm Global

```bash
npm install -g @luberserker0v0/agent-orchestrator
aor serve --config ./ao.config.json
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
