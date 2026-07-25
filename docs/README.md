# AgentOrchestrator Documentation

AgentOrchestrator manages OpenCode AI coding agent instances and exposes REST + WebSocket APIs for external integrations.

## Documentation Paths

### [Architecture](architecture/)
System design, data flows, security model, and module reference.

- [Overview](architecture/README.md) — Layered architecture, core principles
- [Data Flows](architecture/data-flows.md) — Request/response sequences
- [Security](architecture/security.md) — Authentication, RBAC, security headers
- [Modules](architecture/modules.md) — All core modules with method tables

### [User Guide](user/)
Installation, configuration, API reference, and operations.

- [Prerequisites](user/prerequisites.md) — System requirements
- [Installation](user/install.md) — Docker, npm, source install
- [Quick Start](user/quick-start.md) — 5-minute tutorial
- [Configuration](user/configuration/) — All config fields
  - [Server](user/configuration/server.md) — HTTP, auth, API keys
  - [Orchestrator](user/configuration/orchestrator.md) — Instance lifecycle, runtimes
  - [Workspace](user/configuration/workspace.md) — File storage, quotas
  - [Runtime](user/configuration/runtime.md) — Direct and Docker runtimes
- [RBAC](user/rbac/) — Role-based access control
  - [Roles](user/rbac/roles.md) — Admin and observer roles
  - [API Keys](user/rbac/api-keys.md) — Key management and auth
- [API Reference](user/api/) — REST, WebSocket, and SSE APIs
  - [REST](user/api/rest.md) — HTTP endpoints
  - [WebSocket](user/api/websocket.md) — JSON-RPC 2.0 methods
  - [Events](user/api/events.md) — SSE event types
- [Dashboard](user/dashboard.md) — Web UI for managing conversations
- [Deployment](user/deployment/) — Docker, npm, and production setup
- [Runbook](user/runbook/) — Operations, troubleshooting, monitoring

### [Developer Guide](developer/)
Contributing, testing, coding standards, and architecture deep dives.

- [Prerequisites](developer/prerequisites.md) — Dev tools and setup
- [Setup](developer/setup.md) — Clone, install, first run
- [Project Structure](developer/project-structure.md) — Directory layout
- [Coding Standards](developer/coding-standards.md) — TypeScript, ESLint, commits
- [Testing](developer/testing/) — Unit, E2E, and integration tests
- [Contributing](developer/contributing/) — Workflow, PR process, AI agent rules
- [Architecture Deep Dive](developer/architecture-deep-dive/) — Internal design details

## Quick Links

| Task | Document |
|------|----------|
| Install | [Installation](user/install.md) |
| Configure | [Configuration](user/configuration/) |
| First API call | [Quick Start](user/quick-start.md) |
| Deploy to production | [Deployment](user/deployment/) |
| Monitor health | [Monitoring](user/runbook/monitoring.md) |
| Troubleshoot issues | [Troubleshooting](user/runbook/troubleshooting.md) |
| Contribute code | [Contributing](developer/contributing/) |
| Run tests | [Testing Guide](developer/testing/) |
