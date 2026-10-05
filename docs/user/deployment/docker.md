# Docker Deployment

Deploy AgentOrchestrator using Docker for production environments.

## Production Image

```bash
# Pull the latest image
docker pull ghcr.io/anomalyco/opencode:latest

# Run
docker run -d \
  --name agent-orchestrator \
  -p 8080:8080 \
  -v /path/to/config:/app/config \
  -v /path/to/workspace:/app/workspace \
  -v /path/to/logs:/app/logs \
  --log-driver local --log-opt max-size=10m --log-opt max-file=3 \
  ghcr.io/anomalyco/opencode:latest
```

## Volumes

| Container Path | Host Path | Purpose |
|---------------|-----------|---------|
| `/app/config` | Config directory | Configuration files |
| `/app/workspace` | Workspace directory | Conversation workspaces |
| `/app/logs` | AO log directory | Optional rotating JSONL logs |

### Named Volumes (Recommended)

```bash
docker run -d \
  --name agent-orchestrator \
  -p 8080:8080 \
  -v ao-config:/app/config \
  -v ao-workspace:/app/workspace \
  ghcr.io/anomalyco/opencode:latest
```

### Bind Mounts

```bash
docker run -d \
  --name agent-orchestrator \
  -p 8080:8080 \
  -v /opt/agent-orchestrator/config:/app/config \
  -v /opt/agent-orchestrator/workspace:/app/workspace \
  ghcr.io/anomalyco/opencode:latest
```

## Networking

### Host Network Mode

For better performance, use host networking:

```bash
docker run -d \
  --name agent-orchestrator \
  --network host \
  -v ao-config:/app/config \
  -v ao-workspace:/app/workspace \
  ghcr.io/anomalyco/opencode:latest
```

### Bridge Network (Default)

```bash
docker run -d \
  --name agent-orchestrator \
  -p 8080:8080 \
  -p 30000-30100:30000-30100 \
  -v ao-config:/app/config \
  -v ao-workspace:/app/workspace \
  ghcr.io/anomalyco/opencode:latest
```

**Note:** When using bridge networking, you must also expose the port range for OpenCode instances.

## Docker Compose

```yaml
version: '3.8'

services:
  agent-orchestrator:
    image: ghcr.io/anomalyco/opencode:latest
    container_name: agent-orchestrator
    ports:
      - "8080:8080"
      - "30000-30100:30000-30100"
    volumes:
      - ao-config:/app/config
      - ao-workspace:/app/workspace
      - ao-logs:/app/logs
    logging:
      driver: local
      options:
        max-size: "10m"
        max-file: "3"
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s

volumes:
  ao-config:
  ao-workspace:
  ao-logs:
```

```bash
docker compose up -d
```

## Environment Variables

Override config via environment variables:

```bash
docker run -d \
  --name agent-orchestrator \
  -p 8080:8080 \
  -e AGENTORCHESTRATOR_SERVER_PORT=8080 \
  -e AGENTORCHESTRATOR_ORCHESTRATOR_MAX_INSTANCES=20 \
  -v ao-config:/app/config \
  -v ao-workspace:/app/workspace \
  ghcr.io/anomalyco/opencode:latest
```

## Health Checks

### Docker HEALTHCHECK

```bash
curl -f http://localhost:8080/health || exit 1
```

### Manual Check

```bash
docker exec agent-orchestrator curl -f http://localhost:8080/health
```

## Logs

Two independent policies apply:

- Docker/Compose rotates the AO container's stdout/stderr with the service
  `logging` block.
- `logging.file` in AgentOrchestrator mirrors filtered records to JSONL under
  `/app/logs`; mount that path if those files must survive container replacement.

For Docker-runtime OpenCode instances, configure `orchestrator.runtimes[].config.logging`
to bound each spawned container's engine logs.

```bash
# View logs
docker logs agent-orchestrator

# Follow logs
docker logs -f agent-orchestrator

# View last 100 lines
docker logs --tail 100 agent-orchestrator
```

## Stopping

```bash
# Graceful stop (sends SIGTERM, waits for shutdownTimeoutMs)
docker stop agent-orchestrator

# Force stop
docker kill agent-orchestrator
```

## Troubleshooting

### Container Won't Start

```bash
# Check container logs
docker logs agent-orchestrator

# Check if config is mounted correctly
docker exec agent-orchestrator ls -la /app/config
```

### Port Already in Use

```bash
# Find process using port 8080
lsof -i :8080

# Use a different port
docker run -d -p 9090:8080 ...
```

### OpenCode Instances Can't Start

Ensure Docker is running and the OpenCode image is accessible:

```bash
docker pull ghcr.io/anomalyco/opencode:latest
```
