# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- feat(agent-runtime): add AgentRuntime interface with spawn/kill/restart/cleanupOrphans (#57)
- feat(agent-runtime): add RuntimeRegistry for runtime lookup by agentType (#57)
- feat(agent-runtime): add OpenCodeRuntime with Docker container lifecycle (#57)

### Changed

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
