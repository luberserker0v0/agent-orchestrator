# Prerequisites

Before installing AgentOrchestrator, ensure your system meets the following requirements.

## Required

| Requirement | Version | Purpose |
|-------------|---------|---------|
| **Node.js** | >= 24.0.0 | Runtime |
| **npm** | >= 10.0.0 | Package manager |

## Optional (for Docker runtime)

| Requirement | Version | Purpose |
|-------------|---------|---------|
| **Docker** | >= 20.10 | Container runtime for OpenCode instances |

## Optional (for local runtime)

| Requirement | Version | Purpose |
|-------------|---------|---------|
| **OpenCode CLI** | >= 1.17.0 | AI coding agent binary |

## Verifying Installation

```bash
node --version   # Should show v24.x.x or higher
npm --version    # Should show 10.x.x or higher
docker --version # Should show 20.x.x or higher (if using Docker)
opencode --version # Should show 1.17.x or higher (if using direct runtime)
```

## System Requirements

- **OS:** Linux, macOS, or Windows (with WSL2 for Docker)
- **Memory:** 512MB+ free RAM (each OpenCode instance uses ~100-200MB)
- **Disk:** 1GB+ free space (for workspace data and Docker images)
- **Network:** Internet access (for pulling Docker images and connecting to LLM providers)
