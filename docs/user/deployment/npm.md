# npm Deployment

Deploy AgentOrchestrator using npm for single-server environments.

## Global Install

```bash
npm install -g agent-orchestrator
```

### CLI Usage

```bash
aor [options] [subcommand]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--port <number>` | HTTP server port | `0` (auto-assign) |
| `--host <address>` | Bind address | `127.0.0.1` |
| `--config <path>` | Config file path | Auto-discover |

| Subcommand | Description |
|------------|-------------|
| `aor dashboard` | Open dashboard in browser |

### Examples

```bash
# Run with default config
aor

# Run on specific port
aor --port 8080

# Run with custom config
aor --config /etc/agent-orchestrator/config.json

# Open dashboard
aor dashboard
```

## PM2 (Process Manager)

For production, use PM2 to manage the process:

```bash
# Install PM2
npm install -g pm2

# Start AgentOrchestrator
pm2 start $(which aor) --name agent-orchestrator

# Save process list
pm2 save

# Auto-start on boot
pm2 startup
```

### PM2 Ecosystem File

```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'agent-orchestrator',
    script: 'aor',
    args: '--port 8080',
    env: {
      NODE_ENV: 'production',
      AGENTORCHESTRATOR_SERVER_PORT: 8080
    },
    max_memory_restart: '1G',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: '/var/log/agent-orchestrator/error.log',
    out_file: '/var/log/agent-orchestrator/out.log'
  }]
};
```

```bash
pm2 start ecosystem.config.js
```

## systemd (Linux)

Create a systemd service file:

```ini
# /etc/systemd/system/agent-orchestrator.service
[Unit]
Description=AgentOrchestrator
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=agent-orchestrator
Group=agent-orchestrator
WorkingDirectory=/opt/agent-orchestrator
ExecStart=/usr/bin/aor --port 8080
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=agent-orchestrator

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/agent-orchestrator/workspace

# Environment
Environment=NODE_ENV=production
Environment=AGENTORCHESTRATOR_SERVER_PORT=8080

[Install]
WantedBy=multi-user.target
```

```bash
# Reload systemd
sudo systemctl daemon-reload

# Enable and start
sudo systemctl enable agent-orchestrator
sudo systemctl start agent-orchestrator

# Check status
sudo systemctl status agent-orchestrator

# View logs
sudo journalctl -u agent-orchestrator -f
```

## Source Install

```bash
# Clone
git clone https://github.com/luberserker0v0/agent-orchestrator.git
cd agent-orchestrator

# Install dependencies
npm install

# Build
npm run build

# Run
npm start

# Or development mode
npm run dev
```

## Updating

```bash
# npm global
npm update -g agent-orchestrator

# Source
git pull origin main
npm install
npm run build
```

## Log Management

### PM2 Logs

```bash
# View logs
pm2 logs agent-orchestrator

# Log rotation
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

### systemd Logs

```bash
# View logs
journalctl -u agent-orchestrator -f

# Rotate
sudo journalctl --vacuum-size=100M
```
