# Installation

AgentOrchestrator can be installed via Docker, npm, or from source.

## Docker (Recommended for Production)

```bash
# Pull the latest image
docker pull ghcr.io/anomalyco/opencode:latest

# Run AgentOrchestrator
docker run -d \
  --name agent-orchestrator \
  -p 8080:8080 \
  -v /path/to/config:/app/config \
  -v /path/to/workspace:/app/workspace \
  ghcr.io/anomalyco/opencode:latest
```

## npm Global Install

```bash
# Install globally
npm install -g agent-orchestrator

# Run
aor
```

### CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| `--port <number>` | HTTP server port | `0` (auto-assign) |
| `--host <address>` | Bind address | `127.0.0.1` |
| `--config <path>` | Config file path | Auto-discover |

### Subcommands

| Command | Description |
|---------|-------------|
| `aor dashboard` | Open dashboard in browser |

## Source Install

```bash
# Clone the repository
git clone https://github.com/luberserker0v0/agent-orchestrator.git
cd agent-orchestrator

# Install dependencies
npm install

# Copy and customize config
cp config/agentorchestrator.example.json config/agentorchestrator.json

# Run in development mode
npm run dev

# Or build and run in production
npm run build
npm start
```

## Configuration

After installation, configure AgentOrchestrator by creating a config file. The system searches for configuration in this order:

1. `--config <path>` CLI argument
2. `./ao.config.json` (current directory)
3. `./config/agentorchestrator.json` (current directory)
4. `./config/agentorchestrator.example.json` (fallback)

See [Configuration Reference](configuration/) for all available options.

## Quick Verify

```bash
# Check health endpoint
curl http://localhost:8080/health

# Expected response:
# { "status": "ok" }
```
