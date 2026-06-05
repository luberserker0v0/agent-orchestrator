# AgentOrchestrator Development Guide

This document defines the standard development workflow for all contributors,
including AI agents. Every change to this repository must follow these rules.

## Mandatory Development Workflow

### 1. Always Start from main

```bash
git checkout main
git pull origin main
git checkout -b feat/<descriptive-name>
```

**Never** commit directly to `main`.

### 2. Code, Test, Build

After making changes, run the full verification pipeline:

```bash
npm run lint       # Must pass with 0 errors
npm run test       # Must pass with 100% success
npm run build      # TypeScript must compile cleanly
```

Shortcut (runs all three):

```bash
npm run preflight
```

### 2a. Commit Completeness Check

After making your final commit, verify **no changes are left behind**:

```bash
git status
```

If the working tree is not clean, either:
- Stage and commit the remaining changes, or
- Add them to `.gitignore` if they should not be tracked

**Never push while there are uncommitted modifications.**

### 3. Git Hooks

This project uses Git hooks to enforce quality. Install them once:

```bash
node scripts/setup-hooks.js
```

- `pre-commit` automatically runs `npm run lint`
- `pre-push` automatically runs `npm run preflight` (lint + test + build)

To bypass in emergencies only: `git commit --no-verify` or `git push --no-verify`

### 4. Commit Message Format

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

<body>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

Examples:

```
feat(orchestrator): add LRU eviction for max instances
test(port-pool): add unit tests for allocation edge cases
fix(websocket): resolve heartbeat timeout handling
```

### 5. Pull Request Process

1. Push the feature branch:
   ```bash
   git push -u origin feat/<name>
   ```

2. Create a Pull Request using the template in `.github/pull_request_template.md`

3. Wait for GitHub Actions CI to pass (lint + test + build on Node 20.x and 22.x)

4. Review the PR description checklist. All items must be checked.

5. Merge only after CI is green. Use "Squash and merge".

6. Delete the feature branch after merge.

### 6. PR Description Template

When creating a PR, use the following structure (also available as a template on GitHub):

```markdown
## Summary
Brief description of what changed and why.

## Changes
- List each significant change
- Include file names if helpful

## Testing
- How was this tested?
- Any manual verification steps?

## Checklist
- [ ] `npm run lint` passes
- [ ] `npm run test` passes
- [ ] `npm run build` compiles
- [ ] Tests added for new logic
- [ ] Documentation updated if needed
- [ ] Follows Conventional Commits
```

## Lint Warning Policy

- `npm run lint` **errors** must be 0 before any commit or push
- **Warnings are tolerated** but should not be increased:
  - Do not introduce new warnings in new code
  - `*.test.ts` files may use `any` for mocks (existing warnings)
  - Gradual cleanup of existing warnings is encouraged but not required
- Treat warnings as indicators of technical debt, not blockers

## AI Agent Git Rules

These rules apply when AI agents (including automated tools) interact with this repository:

- **AI must NOT** run `git commit --amend`, `git rebase`, `git push --force`, or any command that rewrites git history. These operations destroy the code review context and can corrupt CI/build pipelines.
- **AI must NOT** infer the current branch state via `git branch` or `git status` to decide actions. If the user invokes `/review` or similar without stating their branch, the AI must ask for confirmation.
- **AI must NOT** create branches (`git checkout -b`) unless explicitly instructed by the user.
- **AI must** create a new conventional commit for each set of changes. Do not amend or squash commits on behalf of the user.
- **The user is responsible for branch management.** AI follows the user's explicit instructions for git operations.

## CHANGELOG.md Format

Follow [Keep a Changelog](https://keepachangelog.com/) v1.1.0.

Update the `[Unreleased]` section in each PR. Categories:

- **Added** — New features
- **Changed** — Changes to existing functionality
- **Fixed** — Bug fixes
- **Removed** — Deprecated features removed

Example:

```markdown
## [Unreleased]

### Added
- feat(orchestrator): add LRU eviction for max instances (#7)

### Fixed
- fix(websocket): resolve heartbeat timeout handling (#10)
```

## Project Structure

```
src/
  config-loader.ts           # Configuration loading with env overrides
  index.ts                   # Application entry point
  http-api/
    server.ts                # Express HTTP server with conversation lifecycle, config, agents, files, sessions, events endpoints
  orchestrator/
    conversation-state.ts    # Event-driven conversation lifecycle with subscription and event replay
    instance-manager.ts      # OpenCode instance lifecycle with workspace reuse
    port-pool.ts             # Dynamic port allocation
    workspace-factory.ts     # Workspace creation, config/agent/file CRUD, copy, quota, path sanitization
  opencode-cli/
    models.ts                # CLI model listing
  opencode-http/
    client.ts                # OpenCode HTTP API client
    types.ts                 # TypeScript types for OpenCode API
  utils/
    logger.ts                # Structured logging with level/format control
  websocket/
    connection.ts            # JSON-RPC 2.0 WebSocket handler
    router.ts                # WebSocket routing with 20+ JSON-RPC methods, event pushing, prepared-phase handling
```

## Technology Stack

- **Runtime**: Node.js >= 20.0.0
- **Language**: TypeScript 5.4 (strict mode)
- **Framework**: Express 4.x
- **WebSocket**: ws 8.x
- **Testing**: Vitest 4.x
- **Linting**: ESLint 10.x with typescript-eslint
- **Process Management**: cross-spawn, tree-kill

## Environment Variables

Any `config/agentorchestrator.json` field can be overridden via environment variables:

```bash
AGENTORCHESTRATOR_SERVER_PORT=8080
AGENTORCHESTRATOR_SERVER_SHUTDOWN_TIMEOUT_MS=15000
AGENTORCHESTRATOR_ORCHESTRATOR_MAX_INSTANCES=20
AGENTORCHESTRATOR_ORCHESTRATOR_IDLE_TIMEOUT_MS=600000
AGENTORCHESTRATOR_ORCHESTRATOR_IDLE_SWEEP_INTERVAL_MS=60000
```

## Server Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `port` | integer | 0 | HTTP server port (0 = auto-assign) |
| `host` | string | '127.0.0.1' | Bind address |
| `shutdownTimeoutMs` | integer | 15000 | Maximum time in ms for graceful shutdown before force exit |

## Orchestrator Configuration

The `orchestrator` section in `config/agentorchestrator.json` controls instance lifecycle:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxInstances` | integer | 10 | Strict upper limit of concurrent OpenCode instances |
| `idleTimeoutMs` | integer | 600000 | Time in ms before an unused instance is auto-destroyed (0 = disabled) |
| `idleSweepIntervalMs` | integer | 60000 | How often the background sweep checks for idle instances |
| `portRange.start` | integer | 30000 | First port in the dynamic allocation range |
| `portRange.end` | integer | 30100 | Last port in the dynamic allocation range |
| `healthCheck.retries` | integer | 10 | Number of health check attempts before giving up |
| `healthCheck.intervalMs` | integer | 500 | Delay between health check retries |

**Validation rule:** `maxInstances` must not exceed the number of available ports (`portRange.end - portRange.start + 1`). The application will refuse to start if this constraint is violated.

## Graceful Shutdown

On `SIGINT` or `SIGTERM`, the orchestrator performs a graceful shutdown:

1. Stops the idle sweep timer
2. Closes all WebSocket connections cleanly (code 1001)
3. Stops accepting new HTTP connections
4. Waits for in-flight HTTP requests to finish (up to `shutdownTimeoutMs`)
5. Destroys all active OpenCode instances
6. Exits cleanly, or force-exits if the timeout is exceeded

## Prometheus Metrics

AgentOrchestrator exposes a Prometheus-compatible `/metrics` endpoint:

```bash
curl http://localhost:8080/metrics
```

### Available Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `agentorchestrator_instances_active` | Gauge | Currently active OpenCode instances |
| `agentorchestrator_instances_total_created` | Counter | Total instances created since startup |
| `agentorchestrator_port_pool_available` | Gauge | Available ports in the dynamic pool |
| `agentorchestrator_websocket_connections_active` | Gauge | Active WebSocket connections |
| `agentorchestrator_http_requests_total` | Counter | Total HTTP requests (labels: method, status) |
| `nodejs_*` | Various | Node.js process metrics (memory, CPU, GC, event loop) |

### Configuration for Prometheus

Add the following job to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'agentorchestrator'
    static_configs:
      - targets: ['localhost:8080']
    metrics_path: /metrics
```

## Common Commands

```bash
npm run dev           # Development mode (tsx watch)
npm run build         # Compile TypeScript to dist/
npm start             # Run compiled production build
npm run test          # Run all tests once
npm run test:watch    # Run tests in watch mode
npm run lint          # Check code style
npm run lint:fix      # Auto-fix lint issues
npm run preflight     # Run lint + test + build in sequence
node scripts/setup-hooks.js  # Install Git hooks
```

## Important Notes for AI Agents

- **Do not** use `git push origin main` directly
- **Do not** skip `npm run lint` or `npm run test` before committing
- **Do not** forget to update `CHANGELOG.md` for user-facing changes
- **Always** create a feature branch before making changes
- **Always** run `git status` after the final commit to confirm the working tree is clean
- **Always** verify `npm run preflight` passes before pushing
- **Always** use the PR template when creating pull requests
- **Always** wait for CI to pass before merging
- When adding new features, include unit tests in `*.test.ts` files alongside the source
