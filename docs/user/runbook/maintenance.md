# Maintenance

Regular maintenance tasks for AgentOrchestrator deployments.

## Upgrades

### npm Global

```bash
# Update
npm update -g agent-orchestrator

# Verify
aor --version

# Restart (if using PM2)
pm2 restart agent-orchestrator
```

### Docker

```bash
# Pull new image
docker pull ghcr.io/anomalyco/opencode:latest

# Stop and remove old container
docker stop agent-orchestrator
docker rm agent-orchestrator

# Start new container (same volumes)
docker run -d \
  --name agent-orchestrator \
  -p 8080:8080 \
  -v ao-config:/app/config \
  -v ao-workspace:/app/workspace \
  ghcr.io/anomalyco/opencode:latest
```

### Source

```bash
# Pull latest
git pull origin main

# Install dependencies
npm install

# Build
npm run build

# Restart
# If using PM2: pm2 restart agent-orchestrator
# If using systemd: sudo systemctl restart agent-orchestrator
```

## Config Migration

When upgrading, check the [CHANGELOG](../../CHANGELOG.md) for config schema changes. Common migrations:

1. Add new required fields
2. Rename deprecated fields
3. Update validation rules

```bash
# Validate config
node -e "require('./dist/config-loader').loadConfig()" 2>&1

# If validation fails, update config and retry
```

## Backup

### What to Back Up

| Item | Location | Frequency |
|------|----------|-----------|
| Config file | `config/agentorchestrator.json` | On change |
| Workspace data | `./workspace/` | Daily |
| Docker volumes | `ao-config`, `ao-workspace` | Daily |

### Backup Commands

```bash
# Config backup
cp config/agentorchestrator.json config/agentorchestrator.json.bak

# Workspace backup (tar)
tar -czf workspace-backup-$(date +%Y%m%d).tar.gz ./workspace/

# Docker volume backup
docker run --rm -v ao-workspace:/data -v $(pwd):/backup alpine \
  tar -czf /backup/workspace-backup-$(date +%Y%m%d).tar.gz -C /data .
```

### Restore

```bash
# Workspace restore
tar -xzf workspace-backup-20260101.tar.gz

# Docker volume restore
docker run --rm -v ao-workspace:/data -v $(pwd):/backup alpine \
  tar -xzf /backup/workspace-backup-20260101.tar.gz -C /data
```

## Capacity Planning

### Resource Estimation

| Resource | Per Instance | Formula |
|----------|-------------|---------|
| Memory | ~100-200 MB | `instances × 150MB` |
| Disk | ~50-100 MB | `instances × 75MB` |
| Ports | 1 | `instances × 1` |
| CPU | ~0.1 core | `instances × 0.1` |

### Recommended Limits

| Deployment | maxInstances | Memory | Disk |
|------------|-------------|--------|------|
| Development | 5 | 2 GB | 1 GB |
| Small production | 10 | 4 GB | 5 GB |
| Medium production | 20 | 8 GB | 10 GB |
| Large production | 50+ | 16 GB+ | 50 GB+ |

### Monitoring Capacity

```bash
# Check current usage
curl http://localhost:8080/metrics | grep instances_active
curl http://localhost:8080/metrics | grep port_pool_available

# Check memory
curl http://localhost:8080/metrics | grep nodejs_heap
```

## Periodic Maintenance

| Task | Frequency | Command |
|------|-----------|---------|
| Check health | Daily | `curl http://localhost:8080/health` |
| Review metrics | Weekly | Check Grafana dashboard |
| Clean old workspaces | Weekly | `rm -rf ./workspace/{old-conversation-id}` |
| Update dependencies | Monthly | `npm update` |
| Rotate API keys | Quarterly | Update `server.apiKeys` in config |
| Backup workspace | Daily | See backup commands above |
| Review logs | Weekly | Check for errors, warnings |
| Test graceful shutdown | Monthly | `kill -SIGTERM <pid>` and verify |

## Log Rotation

### PM2

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
```

### systemd

```bash
# Check current journal size
journalctl --disk-usage

# Rotate
sudo journalctl --vacuum-size=100M

# Configure persistent journal
sudo mkdir -p /var/log/journal
sudo systemd-tmpfiles --create --prefix /var/log/journal
```

### Docker

```bash
# Configure Docker log driver
docker run --log-driver=json-file --log-opt max-size=10m --log-opt max-file=3 ...
```

## Disaster Recovery

### Scenario: Server Crash

1. Restart the server
2. On startup, the server automatically:
   - Cleans up orphaned Docker containers
   - Cleans up orphaned workspace directories
   - Resets conversation states
3. Verify health: `curl http://localhost:8080/health`

### Scenario: Workspace Corruption

1. Stop the server
2. Restore workspace from backup
3. Restart the server
4. Verify conversations are accessible

### Scenario: Config Loss

1. Restore config from backup
2. Restart the server
3. If using Docker, re-mount the config volume

## Security Maintenance

| Task | Frequency | Action |
|------|-----------|--------|
| Rotate API keys | Quarterly | Update `server.apiKeys` |
| Update dependencies | Monthly | `npm update` |
| Review access logs | Weekly | Check for unauthorized access |
| Update Docker image | Monthly | Pull latest image |
| Review permissions | Quarterly | Audit `apiKeys` roles |
