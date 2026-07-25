# Troubleshooting

Common issues and their solutions.

## OpenCode Instance Won't Start

### Symptoms

- Conversation status stays at `starting` or transitions to `stopped`
- `lastError` contains spawn failure message

### Causes & Solutions

| Cause | Solution |
|-------|----------|
| Binary not found | Verify `binary` path in runtime config. Run `which opencode` to check. |
| Docker not running | Start Docker daemon. Run `docker info` to verify. |
| Port range exhausted | Increase `portRange.end` or decrease `maxInstances` |
| Insufficient memory | Free memory or reduce `maxInstances` |

### Debug Steps

```bash
# Check runtime config
curl http://localhost:8080/api/runtimes

# Check available ports
curl http://localhost:8080/metrics | grep port_pool

# Check instance count
curl http://localhost:8080/metrics | grep instances_active

# Test OpenCode binary directly
opencode --version
```

## Health Check Failures

### Symptoms

- Instance status shows `stopped` with health check error
- Logs show repeated health check attempts

### Causes & Solutions

| Cause | Solution |
|-------|----------|
| OpenCode slow to start | Increase `healthCheck.retries` or `healthCheck.intervalMs` |
| Wrong port | Verify `instanceHost` and port allocation |
| Network issue (Docker) | Check Docker networking, try `networkMode: host` |
| Password mismatch | Restart the conversation (passwords are ephemeral) |

### Debug Steps

```bash
# Check health check config
curl http://localhost:8080/metrics | grep health

# Test health endpoint directly (if you know the port)
curl http://localhost:30000/health

# Check Docker container
docker ps | grep opencode
docker logs <container-name>
```

## Docker Networking Issues

### Symptoms

- Instance starts but health check fails
- Connection refused errors

### Solutions

1. **Use host networking:**
   ```jsonc
   { "networkMode": "host" }
   ```

2. **Expose port range:**
   ```bash
   docker run -p 30000-30100:30000-30100 ...
   ```

3. **Check Docker network:**
   ```bash
   docker network ls
   docker network inspect bridge
   ```

## WebSocket Connection Issues

### Symptoms

- Dashboard shows "Connection refused"
- WebSocket closes immediately

### Solutions

| Issue | Solution |
|-------|----------|
| Wrong port | Verify server port in config or `--port` flag |
| Auth required | Include `?apiKey=...` in WebSocket URL |
| CORS blocked | Check browser console for CORS errors |
| Connection limit | Only one WS per conversation; new replaces old |

### Debug Steps

```bash
# Test WebSocket connection
wscat -c "ws://localhost:8080/ws/conversation-id?apiKey=your-key"

# Check active connections
curl http://localhost:8080/metrics | grep websocket_connections
```

## Workspace Cleanup

Orphaned workspaces from crashed instances:

```bash
# List workspace directories
ls -la ./workspace/

# Remove specific conversation workspace
rm -rf ./workspace/{conversation-id}

# Remove all (WARNING: destroys all data)
rm -rf ./workspace/*
```

The server automatically cleans up orphaned containers and workspaces on startup.

## High Memory Usage

### Symptoms

- Process memory grows over time
- System becomes unresponsive

### Solutions

1. **Reduce max instances:**
   ```jsonc
   { "orchestrator": { "maxInstances": 5 } }
   ```

2. **Reduce idle timeout:**
   ```jsonc
   { "orchestrator": { "idleTimeoutMs": 300000 } }
   ```

3. **Check for leaks:**
   ```bash
   curl http://localhost:8080/metrics | grep nodejs_heap
   ```

## Port Conflicts

### Symptoms

- `EADDRINUSE` error on startup
- Instance can't bind to port

### Solutions

```bash
# Find process using port
lsof -i :8080
netstat -tlnp | grep 8080

# Use a different port
aor --port 9090

# Or configure port range
{ "orchestrator": { "portRange": { "start": 40000, "end": 40100 } } }
```

## Log Analysis

### Key Log Patterns

| Pattern | Meaning |
|---------|---------|
| `Health check passed` | Instance is ready |
| `Health check failed` | Instance not responding |
| `Idle timeout` | Instance destroyed due to inactivity |
| `Connection replaced` | New WebSocket replaced existing |
| `Workspace quota exceeded` | File write rejected |

### Enabling Debug Logging

Set the `LOG_LEVEL` environment variable:

```bash
LOG_LEVEL=debug aor
```
