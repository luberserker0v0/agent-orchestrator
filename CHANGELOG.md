# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- feat(orchestrator): `ConversationState` with event-driven lifecycle (`prepared` → `starting` → `running` → `stopped`/`restarting` → `destroyed`), subscription model, and recent event replay (max 100).
- feat(orchestrator): `WorkspaceFactory` workspace reuse (`hasWorkspace`, `ensure`), config/agent/file CRUD, `copyFromLocal` with allowed-source validation, 50MB quota enforcement, and path-traversal blocking.
- feat(opencode-http): `listSessions()`, `getSessionChildren()`, `forkSession()` for OpenCode session tree traversal.
- feat(http-api): full REST endpoints for delayed-start conversation lifecycle (`/conversations` prepare, `/:id/start|stop|restart`), config (`/:id/config`), agent auto-discovery (`/:id/agents`), generic file CRUD (`/:id/files`), session tree (`/:id/sessions/...`), and event replay (`/:id/events`).
- feat(websocket): 20+ JSON-RPC methods, event pushing via `conversationState.subscribe()`, prepared-phase connection handling, no auto-create on WS connect.
- feat(instance-manager): reuse existing workspaces on `createInstance` to preserve pre-configured agents/files across restarts.
- feat(skills): Skill CRUD API with `POST /skills/upload` (zip archive), `POST /skills/import` (local directory), `GET /skills`, `GET /skills/:name`, `GET /skills/:name/info` (structure + sha256 hash), and `DELETE /skills/:name`. Skills stored as `.opencode/skills/{name}/` directories.
- test: 149 total tests including new coverage for `conversation-state`, `workspace-factory` CRUD, `client` session tree, `server`/`router` mocks, and skill CRUD.

### Changed

- `POST /api/conversations` now prepares workspace only; `POST /:id/start` spawns the OpenCode process, enabling pre-configuration of agents and files before launch.
- `message.send` remains conversation-scoped via WebSocket; session-scoped operations (list, fork, delete) moved to HTTP REST endpoints.
- Skill API now returns more precise 400/403/404/413 errors.
- Documented Blender multi-expert skill provisioning flow and restart behavior.

### Fixed

- Path parameters for file APIs moved to request body to avoid URL encoding/special-char issues and path-traversal risks in routing.
- Hardened skill zip upload against zip slip and unsafe skill names.
- Rejected malformed skill archives without root SKILL.md.
- Skill zip upload path containment now uses `resolve()` for proper normalization and boundary checking.
- All skill APIs (REST and WebSocket) now reject invalid names via `validateSkillName()` instead of silently sanitizing with `sanitizeId()`.
