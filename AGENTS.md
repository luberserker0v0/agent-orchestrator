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
  agent-runtime/
    types.ts                 # AgentRuntime interface, AgentEndpoint type
    registry.ts              # RuntimeRegistry — runtime lookup by id
    runtime-manager.ts       # RuntimeManager — manages instance map, lifecycle, policy queries (LRU candidate, idle detection)
    runtimes/
      direct.ts              # DirectRuntime — spawns opencode binary as child process, ChildProcessHandle wraps treeKill. Accepts DirectRuntimeConfig ({ binary })
      docker.ts              # DockerRuntime — spawns Docker container, DockerHandle wraps docker rm -f. Accepts DockerRuntimeConfig ({ image, containerPort })
  http-api/
    server.ts                # Express HTTP server with conversation lifecycle, config, agents, files, sessions, events endpoints
  orchestrator/
    conversation-state.ts    # Event-driven conversation lifecycle with subscription and event replay
    instance-manager.ts      # OpenCode instance lifecycle with workspace reuse
    port-pool.ts             # Dynamic port allocation
    workspace-factory.ts     # Workspace creation, config/agent/file CRUD, copy, quota, path sanitization
  services/
    agent-service.ts         # Agent CRUD and config endpoints
    config-service.ts        # Config read/write/patch
    conversation-service.ts  # Conversation lifecycle orchestration (start/stop/restart/delete)
    file-service.ts          # File CRUD with 50MB quota enforcement
    message-service.ts       # Message send and history with model parsing
    session-service.ts       # Session proxy with ensureReady guard
    skill-service.ts         # Skill upload, import, CRUD, info
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
AGENTORCHESTRATOR_WORKSPACE_MAXSIZEBYTES=104857600  # 0 = unlimited

# Note: The `runtimes` array (list of runtime entries) is NOT overridable via env vars.
# Arrays are treated as opaque by mergeDefaults. Multi-runtime setups use the JSON config file.
```

## Server Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `port` | integer | 0 | HTTP server port (0 = auto-assign) |
| `host` | string | '127.0.0.1' | Bind address |
| `shutdownTimeoutMs` | integer | 15000 | Maximum time in ms for graceful shutdown before force exit |
| `apiKey` | string | (none) | Optional bearer token for API authentication. All endpoints except `/health`, `/metrics`, `/api-docs*` require `Authorization: Bearer <key>`. Min 8 characters. |

## Orchestrator Configuration

The `orchestrator` section in `config/agentorchestrator.json` controls instance lifecycle:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxInstances` | integer | 10 | Strict upper limit of concurrent OpenCode instances |
| `idleTimeoutMs` | integer | 600000 | Time in ms before an unused instance is auto-destroyed (0 = disabled) |
| `idleSweepIntervalMs` | integer | 60000 | How often the background sweep checks for idle instances |
| `portRange.start` | integer | 30000 | First port in the dynamic allocation range |
| `portRange.end` | integer | 30100 | Last port in the dynamic allocation range |
| `defaultAgentType` | string | 'opencode' | Default agent type — must match the `id` of one runtime entry in `runtimes[]` |
| `runtimes` | array | `[{ id: 'opencode', type: 'direct', config: { binary: 'opencode' } }]` | Array of runtime entries. Each entry has `id`, `type` (`direct` or `docker`), and `config` |
| `runtimes[].config.binary` | string | `opencode` | OpenCode CLI command or absolute path |
| `runtimes[].config.instanceHost` | string | `'127.0.0.1'` | Hostname used to reach started OpenCode instances (per-runtime, useful for remote Docker hosts) |
| `runtimes[].config.docker.image` | string | (required for docker) | Docker image name (e.g. `ghcr.io/anomalyco/opencode:1.17.4`) |
| `runtimes[].config.docker.containerPort` | integer | (required for docker) | Container port that OpenCode listens on |
| `runtimes[].config.docker.networkMode` | string | (none) | Docker network mode (`host`, `bridge`, or custom network name). When `host`, port mapping is skipped. |
| `healthCheck.retries` | integer | 10 | Number of health check attempts before giving up |
| `healthCheck.intervalMs` | integer | 500 | Delay between health check retries |
| `healthCheck.clientTimeoutMs` | integer | 5000 | HTTP client timeout per health check request |
| `sse.enabled` | boolean | true | Enable SSE event forwarding from OpenCode instances to WebSocket clients |
| `sse.reconnectMaxAttempts` | integer | 10 | Max reconnect attempts before giving up |
| `sse.reconnectBaseMs` | integer | 1000 | Base delay in ms for exponential backoff |
| `sse.filterHeartbeat` | boolean | true | Filter heartbeat events to reduce noise |

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
| `agentorchestrator_instances_errors_total` | Counter | Total instance errors (labels: type) |
| `agentorchestrator_instance_spawn_duration_seconds` | Histogram | Time to spawn an OpenCode instance |
| `agentorchestrator_port_pool_available` | Gauge | Available ports in the dynamic pool |
| `agentorchestrator_websocket_connections_active` | Gauge | Active WebSocket connections |
| `agentorchestrator_http_requests_total` | Counter | Total HTTP requests (labels: method, status) |
| `agentorchestrator_http_request_duration_seconds` | Histogram | HTTP request duration in seconds (labels: method, status) |
| `agentorchestrator_conversation_state_changes_total` | Counter | Total conversation state transitions (labels: status) |
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
npm run test          # Run all unit tests once
npm run test:watch    # Run tests in watch mode
npm run lint          # Check code style
npm run lint:fix      # Auto-fix lint issues
npm run preflight     # Run lint + test + build in sequence
node scripts/setup-hooks.js  # Install Git hooks
```

### E2E Tests

E2E tests are split by runtime to reduce overlap. All orchestrator-layer tests (lifecycle, workspace, resource limits, idle timeout) run on Docker by default since they are runtime-agnostic.

```bash
npm run test:e2e            # Run orchestrator E2E tests (Docker runtime, default)
npm run test:e2e:docker     # Explicit Docker runtime E2E tests
npm run test:e2e:direct     # Direct runtime E2E tests (requires local opencode binary)
npm run test:e2e:runtime    # Runtime-specific E2E tests (Docker: container lifecycle)
npm run test:e2e:watch      # Watch mode for E2E tests
```

**Test categories:**

| Directory | What it tests | Runtime | Skips when unavailable? |
|-----------|--------------|---------|------------------------|
| `e2e/scenarios/lifecycle/` | HTTP/WS conversation lifecycle, message send, ready state | Any (Docker default) | No |
| `e2e/scenarios/orchestrator/` | LRU eviction, idle timeout, process crash recovery | Any (Docker default) | No |
| `e2e/scenarios/workspace/` | File/agent CRUD, path traversal protection | Any (Docker default) | No |
| `e2e/scenarios/runtime/direct-runtime.test.ts` | Process spawn, env vars, SIGTERM, CWD propagation | Direct only | Yes (`describe.skipIf`) |
| `e2e/scenarios/runtime/docker-runtime.test.ts` | Container naming, port mapping, env vars, docker restart | Docker only | Yes (`describe.skipIf`) |

### Docker Build (for orchestrator container)
```bash
docker build -t agent-orchestrator .
docker run -p 8080:8080 -v /path/to/config:/app/config agent-orchestrator
```

## CI/CD Infrastructure

### GitHub Actions (`.github/workflows/ci.yml`)
- Triggered on `push`/`PR` to `main`/`master`
- **Matrix**: Node.js 20.x and 22.x
- **Steps**: `npm ci` → `npm run preflight` (lint + test + build) → `npm run test:coverage` → upload coverage artifact

- **Dependabot**: Weekly updates for npm (grouped dev dependencies) and GitHub Actions (`.github/dependabot.yml`)

### Git Hooks (custom, no Husky)
- **pre-commit**: `npm run lint`
- **pre-push**: `npm run preflight` (lint + test + build)
- Install: `node scripts/setup-hooks.js`

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
