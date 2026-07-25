# AgentOrchestrator

A Node.js orchestrator that manages [OpenCode](https://opencode.ai) AI coding agent instances and exposes REST + WebSocket APIs for external integrations.

## Features

- **Process-level isolation** — Each conversation gets its own OpenCode instance
- **Dynamic port allocation** — Instances auto-assign ports from a configurable range
- **LRU eviction** — Automatically reclaims idle instances when at capacity
- **WebSocket real-time** — JSON-RPC 2.0 with event streaming
- **Role-based access control** — Admin and observer roles via API keys
- **Prometheus metrics** — 9 custom metrics for monitoring
- **Multi-runtime** — Direct process or Docker container execution
- **Built-in dashboard** — Web UI for managing conversations

## Quick Install

```bash
# npm
npm install -g agent-orchestrator
aor

# Docker
docker run -d -p 8080:8080 ghcr.io/anomalyco/opencode:latest

# Source
git clone https://github.com/luberserker0v0/agent-orchestrator.git
cd agent-orchestrator && npm install && npm run dev
```

## Quick Start

```bash
# 1. Create conversation
curl -X POST http://localhost:8080/api/conversations -H "Content-Type: application/json" -d '{}'

# 2. Start instance
curl -X POST http://localhost:8080/api/conversations/{id}/start

# 3. Send message
curl -X POST http://localhost:8080/api/conversations/{id}/message \
  -H "Content-Type: application/json" -d '{"text": "Hello!"}'

# 4. Open dashboard
open http://localhost:8080/dashboard
```

## Documentation

| Path | Description |
|------|-------------|
| [Architecture](docs/architecture/) | System design, data flows, security model |
| [User Guide](docs/user/) | Installation, configuration, API reference, operations |
| [Developer Guide](docs/developer/) | Contributing, testing, coding standards, deep dives |
| [Full Docs Hub](docs/README.md) | Complete documentation index |

## Tech Stack

- **Runtime:** Node.js >= 24.0.0
- **Language:** TypeScript 6.x (strict mode)
- **Framework:** Express 5.x
- **WebSocket:** ws 8.x
- **Testing:** Vitest 4.x
- **Linting:** ESLint 10.x

## License

MIT License
