# Operations Runbook

This section covers day-2 operations: monitoring, troubleshooting, and maintenance.

## Quick Reference

| Task | Command |
|------|---------|
| Check health | `curl http://localhost:8080/health` |
| View metrics | `curl http://localhost:8080/metrics` |
| List conversations | `curl http://localhost:8080/api/conversations` |
| Stop all instances | `curl -X DELETE http://localhost:8080/api/conversations/{id}` for each |
| Restart server | `kill -SIGTERM <pid>` (graceful) |

## Common Tasks

| Task | Guide |
|------|-------|
| Diagnose issues | [Troubleshooting](troubleshooting.md) |
| Monitor health | [Monitoring](monitoring.md) |
| Upgrade or maintain | [Maintenance](maintenance.md) |

## Graceful Shutdown

The server handles `SIGINT` and `SIGTERM` gracefully:

1. Stops idle sweep timer
2. Closes all WebSocket connections (code 1001)
3. Stops accepting new HTTP connections
4. Waits for in-flight requests (up to `shutdownTimeoutMs`)
5. Destroys all OpenCode instances
6. Exits cleanly

**Force exit:** If the timeout is exceeded, the process exits immediately.

```bash
# Graceful stop
kill -SIGTERM $(pgrep -f "agent-orchestrator")

# Check if stopped
curl http://localhost:8080/health  # Should fail
```
