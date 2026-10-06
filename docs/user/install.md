# Installation

AgentOrchestrator can run as a host process, a Docker container, or a Kubernetes
installation. Use one of the end-to-end tutorials for a validated configuration,
authenticated smoke test, persistence check, and safe teardown:

| Mode | Tutorial |
|------|----------|
| Direct host process | [Direct setup](setup/direct.md) |
| Docker container | [Docker setup](setup/docker.md) |
| Kubernetes | [Kubernetes setup](setup/kubernetes.md) |

## Docker (Recommended for Production)

The AgentOrchestrator image is `luberserker/agent-orchestrator:<version>`.
It is different from `ghcr.io/anomalyco/opencode`, which is an OpenCode runtime
image. Follow the [Docker setup](setup/docker.md) for the required configuration,
volumes, API key, startup checks, and lifecycle test.

## npm Global Install

```bash
# Install globally
npm install -g @luberserker0v0/agent-orchestrator

# Run with an explicit, validated config
aor serve --config ./ao.config.json
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
| `aor serve` | Explicitly start the server |
| `aor status` | Check health and authenticated role |
| `aor conversation ...` | Manage conversation lifecycle |
| `aor session ...` | Manage OpenCode sessions |
| `aor cleanup ...` | Preview or execute configured cleanup |
| `aor k8s ...` | Render and manage Kubernetes components |
| `aor dashboard` | Open dashboard in browser |

See the complete [`aor` command reference](cli.md).

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
