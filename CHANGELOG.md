# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- feat(cli): add `aor runtime list` and `aor runtime info <id>` subcommands
- feat(config): add `version` field to DirectRuntimeConfig for version registry
- feat(versions): add version registry helpers (`getRuntimeVersion`, `opencodeDownloadUrl`)
- feat(runtime-info): add RuntimeInfoProvider for aggregated runtime data
- feat(docker): Dockerfile.template with `{{OPENCODE_VERSION}}` placeholder and render script
- feat(ci): add OPENCODE_VERSION build-arg extraction and Dockerfile rendering in CD workflow
- feat(http-api): add GET /api/runtimes endpoint exposing registered runtimes
- feat(config): add Makefile for Docker builds
- feat(config): validate deprecated orchestrator fields (runtime, runtimeConfig, agentType)
- test(health): add 7 unit tests for waitForHealthy retry/failure/timeout logic
- docs(test): add testing strategy section (three-tier) and k8s integration guide to QUICKTEST.md
- feat(ci): add Dockerfile for orchestrator containerization (multi-stage, node:20-alpine, healthcheck)
- feat(ci): add .dockerignore for efficient Docker builds
- feat(ci): add Dependabot config for weekly npm and GitHub Actions updates
- feat(ci): add Docker build job to CI workflow (push to main)
- docs: add RUNBOOK.md with operations guide, troubleshooting, and maintenance tasks
- docs: update README.md with new config fields (apiKey, instanceHost, maxSizeBytes), security features, observability, and multi-runtime support
- docs: update ARCHITECTURE.md for DirectRuntime/DockerRuntime split, InstanceHandle, health.ts, Logger.child, metrics registry, security layer
- docs: update API.md metrics table with 4 new metrics, add auth header note
- test(runtime-manager): add ~34 unit tests covering lifecycle, restart, LRU, idle sweep, edge cases
- test(conversation-state): add 12 tests for cancelReadyCheck coverage
- test(conversation-service): add 14 tests for destroyed guard, stop/restart cancelReadyCheck assertions
- test(instance-manager): add 5 tests for edge cases
- test(router): add 4 tests for race conditions
- test(e2e): add process crash e2e test — kill opencode by port → verify onDestroyed → stopped → recover
- test(e2e): add idle timeout e2e test — auto-destroy → stopped → recover → full lifecycle
- test(e2e): add LRU eviction e2e test — maxInstances exceeded → LRU evict → stopped → recover
- test(conversation-state): add *→stopped transition tests for onDestroyed paths
- test(conversation-service): add onDestroyed simulation tests (restart/stop/delete after crash)

### Fixed

- fix(e2e): add StorageBackend to WorkspaceFactory in e2e server helper (pre-existing crash)
- fix(e2e): add setOnDestroyed callback to e2e server helper (pre-existing — state never transitioned to stopped on eviction/crash/timeout)

### Changed

- refactor(docker): remove `containerPort` from DockerRuntimeConfig; use dynamic port only
- refactor(http-api): enhance GET /api/runtimes with version, config, registered, capabilities
- refactor(config): update example config with `opencode-direct` and `opencode-docker` runtime entries
- refactor(cli): add subcommand parser supporting `aor runtime list|info`
- refactor(makefile): add `render-dockerfile` target and OPENCODE_VERSION build-arg
- build: add `.gitignore` entry for generated Dockerfile
- chore(deps): bump express from 4.22.2 to 5.2.1 and @types/express from 4 to 5 (#70)
- chore(deps): bump the dev-dependencies group (eslint 10.4.1→10.5.0, prettier 3.8.3→3.8.4, typescript 5.9.3→6.0.3, typescript-eslint 8.60.1→8.61.1, vitest 4.1.8→4.1.9, @types/node 20.19.41→25.9.3) (#68)
- chore(deps): bump @vitest/coverage-v8 from 4.1.8 to 4.1.9 (#69)
- chore(deps): bump dotenv from 16.6.1 to 17.4.2 (#71)
- chore(deps): bump actions/checkout from 4 to 6 (#67)
- chore(deps): bump actions/upload-artifact from 4 to 7 (#66)
- chore(deps): bump actions/setup-node from 4 to 6 (#65)
- refactor(runtime): split OpenCodeRuntime into DirectRuntime and DockerRuntime standalone classes with InstanceHandle abstraction (port owned by runtime, ChildProcess behind handle interface)
- refactor(config): add typed `DirectRuntimeConfig` / `DockerRuntimeConfig` interfaces; runtime constructors accept config objects instead of positional params
- feat(config): add `getDirectRuntimeConfig()` / `getDockerRuntimeConfig()` typed helpers with validation
- feat(config): add env var overrides for runtime config (`AGENTORCHESTRATOR_ORCHESTRATOR_RUNTIMECONFIG_BINARY`, `RUNTIMECONFIG_DOCKER_IMAGE`, `RUNTIMECONFIG_DOCKER_CONTAINERPORT`)
- chore(config): validate runtime field (`"direct"` or `"docker"`) and required docker sub-config

### Fixed

- fix(orchestrator): add `cancelReadyCheck(id)` to `onDestroyed` callback to prevent stale `pollKeepalive` closure from flipping `ready=false` after idle sweep kills an instance
- fix(orchestrator): add `cancelReadyCheck(id)` to `conversation-service.stop()` and `restart()` to stop stale polling after manual stop/restart
- fix(runtime-manager): use generation counter in `restartInstance()` to prevent stale `onExit` closure from destroying newly spawned instance
- fix(conversation-service): add `destroyed` guard to `start()` to prevent orphaned RuntimeManager instances when `start()` races with `delete()`
- fix(docker): use dynamic port for container listen (`--port port`) and port mapping (`instanceHost:port:port`)
- fix(docker): baseUrl now uses dynamic port for both bridge and host network modes
- fix(http-api): add type assertions for Express 5 `req.params` compatibility (`string | string[]` → `string`) (#70)
- fix(config-loader): deep-merge parsed config with defaults to prevent missing fields (`agentType` was undefined → kill logic skipped → workspace folder never released)

### Added

- feat(network): add configurable `instanceHost` for OpenCode instance URLs (default: `127.0.0.1`), replacing hardcoded host
- feat(network): add `networkMode` to DockerRuntimeConfig (`host`, `bridge`, or custom network name); when `host`, port mapping is skipped
- feat(network): add `instanceHost` env override (`AGENTORCHESTRATOR_ORCHESTRATOR_RUNTIMECONFIG_INSTANCEHOST`)
- feat(observability): add Logger.child() for context-bound structured logging with requestId/conversationId propagation
- feat(observability): add agentorchestrator_instances_errors_total counter (label: type) for spawn/health errors
- feat(observability): add agentorchestrator_instance_spawn_duration_seconds histogram for spawn timing
- feat(observability): add agentorchestrator_http_request_duration_seconds histogram (labels: method, status)
- feat(observability): add agentorchestrator_conversation_state_changes_total counter (label: status) for lifecycle transitions
- feat(security): add optional apiKey bearer token authentication for HTTP API (min 8 chars, off by default)
- feat(security): add security headers middleware (X-Content-Type-Options, X-Frame-Options, X-DNS-Prefetch-Control)
- feat(security): add apiKey config validation and env override (AGENTORCHESTRATOR_SERVER_APIKEY)
- feat(agent-runtime): add InstanceHandle interface (pid, exitCode, kill, waitForExit, onExit)
- feat(agent-runtime): add ChildProcessHandle wrapping ChildProcess + treeKill in DirectRuntime
- feat(agent-runtime): add DockerHandle wrapping docker rm -f in DockerRuntime
- feat(e2e): verify workspace folder is removed after DELETE conversation in lifecycle, agent-crud, file-crud tests
- feat(instance-manager): log OS-level PID verification (tasklist) after kill cycle to detect surviving processes
- feat(services): add ConversationService, FileService, SessionService, MessageService between transport and domain layers
- feat(utils): add ModelParser utility for providerID/modelID extraction
- feat(errors): add AppError class with statusCode, code, and structured error responses (#59)
- feat(errors): add error code constants (ErrorCodes) for all HTTP and WS error types (#59)
- feat(agent-runtime): add AgentRuntime interface with spawn/kill/restart/cleanupOrphans (#57)
- feat(agent-runtime): add RuntimeRegistry for runtime lookup by agentType (#57)
- feat(agent-runtime): add DirectRuntime and DockerRuntime with InstanceHandle abstraction

### Changed

- docs(config): add `agentType` to agentorchestrator.json for explicit runtime selection
- docs(architecture): separate Runtime Abstraction Layer from Domain Layer in diagrams and core module hierarchy
- refactor(http-api): delegate all route handlers to service layer (~300 lines thinner)
- refactor(websocket): delegate all 12 RPC method groups to service layer
- test(services): add 68 unit tests for ConversationService, FileService, SessionService, MessageService (service layer now at 50%+ coverage)
- fix(e2e): wire 4 missing services into e2e server helper to fix conversation lifecycle failures
- fix(services): return 404 instead of 500 in FileService for missing files/directories
- docs(architecture): update diagrams, data flows, and core modules for service layer
- feat(http-api): change REST error format from `{ error: "msg" }` to `{ error: { code, message } }` (#59)
- feat(websocket): enrich JSON-RPC errors with `data.code` when error is AppError (#59)
- docs: update error format documentation in API.md (#59)
- refactor(orchestrator): replace flat `opencodeBinary`/`docker` fields with `runtime`+`runtimeConfig` in OrchestratorConfig (#57)
- refactor(orchestrator): InstanceManager uses RuntimeRegistry exclusively, no config.runtime conditionals (#57)
- refactor(orchestrator): config shape consolidated — runtime config nested under `runtimeConfig` (#57)

### Added

- feat(api): add GET /api/conversations/:id/providers endpoint (#54)
- feat(api): add PATCH /api/conversations/:id/config endpoint (#54)
- feat(api): enhance GET /api/conversations/:id/agents with runtime data (#54)
- docs: add npm/npx install instructions, `aor` binary CLI reference, and Swagger UI documentation to README.md (#53)
- docs: add `/api-docs`, `/api-docs/`, `/api-docs.json` endpoint documentation to API.md (#53)
- docs: add QUICKSTART.md and QUICKTEST.md for rapid onboarding and testing workflow
- feat(e2e): replace dynamic provider config with static OPENCODE_CONFIG fixture (#46)
- feat(e2e): add cross-env for cross-platform env vars in npm scripts (#46)

### Fixed

- fix(config-loader): always use jsonc-parser for config JSON files to handle comments in `.json` files (#45)
- fix(instance-manager): add 10s timeout to docker restart spawn to prevent indefinite hang (#46)
- fix(e2e): cleanup orphan Docker containers in test server startup/cleanup to prevent container name conflicts on re-runs (#46)

### Removed

- remove GET /api/models endpoint (#54)

### Changed

- docs: sync README, API.md, ARCHITECTURE.md with current codebase (config schema, endpoint tables, WS methods, lifecycle behavior)
- feat(http-api): return 204 No Content from POST /api/conversations/:id/config (#46)

- feat(e2e): restructure scenarios into `workspace/` (runtime-agnostic CRUD) and `lifecycle/` (runtime-specific, runs once per runtime). Runtime selected via `E2E_RUNTIME` env var, no soft-skip logic
- feat(e2e): add `test:e2e:workspace`, `test:e2e:direct`, `test:e2e:docker` scripts for targeted runtime testing
- feat(e2e): add e2e test framework with scenario files (file CRUD, agent CRUD, conversation lifecycle, ready-state, message-send, docker runtime) — tests using real OpenCode instances
- feat(e2e): add message-send scenario with HTTP REST and WebSocket JSON-RPC paths, including error handling
- feat(orchestrator): add canonical opencode.json config with enforced security merge via enforceCanonicalConfig
- fix(orchestrator): use Object.hasOwn() instead of in operator for canonical config key check
- feat(conversation-state): add `isReady` state, `startReadyCheck()` polling mechanism, and `conversation.ready`/`conversation.readyLost` events
- feat(http-api): add `POST /api/conversations/:id/message` for sending text via HTTP REST
- feat(http-api): add dedicated AGENTS.md injection endpoints (`PUT/GET/DELETE /api/conversations/:id/agent/config`) with WS RPC (`agent.config.write/get/delete`)
- feat(http-api): add `POST /api/conversations/:id/config` for raw JSON opencode.json replacement
- feat(orchestrator): `ConversationState` with event-driven lifecycle (`prepared` → `starting` → `running` → `stopped`/`restarting` → `destroyed`), subscription model, and recent event replay (max 100).
- feat(orchestrator): `WorkspaceFactory` workspace reuse (`hasWorkspace`, `ensure`), config/agent/file CRUD, `copyFromLocal` with allowed-source validation, 50MB quota enforcement, and path-traversal blocking.
- feat(opencode-http): `listSessions()`, `getSessionChildren()`, `forkSession()` for OpenCode session tree traversal.
- feat(http-api): full REST endpoints for delayed-start conversation lifecycle (`/conversations` prepare, `/:id/start|stop|restart`), config (`/:id/config`), agent auto-discovery (`/:id/agents`), generic file CRUD (`/:id/files`), session tree (`/:id/sessions/...`), and event replay (`/:id/events`).
- feat(websocket): 20+ JSON-RPC methods, event pushing via `conversationState.subscribe()`, prepared-phase connection handling, no auto-create on WS connect.
- feat(instance-manager): reuse existing workspaces on `createInstance` to preserve pre-configured agents/files across restarts.
- feat(skills): Skill CRUD API with `POST /skills/upload` (zip archive), `POST /skills/import` (local directory), `GET /skills`, `GET /skills/:name`, `GET /skills/:name/info` (structure + sha256 hash), and `DELETE /skills/:name`. Skills stored as `.opencode/skills/{name}/` directories.
- feat(coverage): add vitest coverage config with v8 provider and thresholds (lines 70%, functions 75%, branches 55%, statements 65%)
- test: 376 total tests including expanded coverage for `config-loader`, `instance-manager`, `port-pool`, and `workspace-factory`

### Changed

- feat(orchestrator): remove `model`/`agent`/`default_agent` from `POST /api/conversations`; opencode.json only modified via dedicated config endpoints
- feat(router): drop `instance.defaultModel`/`defaultAgent` fallback in `message.send`; rely on opencode.json values
- `POST /api/conversations` now prepares workspace only; `POST /:id/start` spawns the OpenCode process, enabling pre-configuration of agents and files before launch.
- `message.send` remains conversation-scoped via WebSocket; session-scoped operations (list, fork, delete) moved to HTTP REST endpoints.
- Skill API now returns more precise 400/403/404/413 errors.
- Documented Blender multi-expert skill provisioning flow and restart behavior.

### Fixed

- fix(config-loader): `applyEnvOverrides` now correctly falls back to default when env var is set but empty, instead of overriding with the empty string
- fix(http-api): call `cancelReadyCheck` in start and restart handlers to prevent stale ready polling after instance restart
- fix(http-api): change GET/DELETE file endpoints from `req.body` to `req.query` (REST semantics — GET/DELETE requests don't have body)
- fix(http-api): path traversal errors now return 400 instead of 500 for file write, read, and delete endpoints
- fix(orchestrator): use `path.resolve()` instead of `path.join()` for workspace basePath to handle absolute Windows paths correctly
- Path parameters for file APIs moved to request body to avoid URL encoding/special-char issues and path-traversal risks in routing.
- Hardened skill zip upload against zip slip and unsafe skill names.
- Rejected malformed skill archives without root SKILL.md.
- Skill zip upload path containment now uses `resolve()` for proper normalization and boundary checking.
- All skill APIs (REST and WebSocket) now reject invalid names via `validateSkillName()` instead of silently sanitizing with `sanitizeId()`.
- Hardened `copyFromLocal` and `importSkillFromLocal` source allowlist to reject sibling prefix paths (e.g. `skills_evil/`) using `resolve()` + `sep` boundary checks instead of `startsWith()`.
