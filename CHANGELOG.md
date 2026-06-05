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
- test: 136 total tests including new coverage for `conversation-state`, `workspace-factory` CRUD, `client` session tree, and updated `server`/`router` mocks.

### Changed

- `POST /api/conversations` now prepares workspace only; `POST /:id/start` spawns the OpenCode process, enabling pre-configuration of agents and files before launch.
- `message.send` remains conversation-scoped via WebSocket; session-scoped operations (list, fork, delete) moved to HTTP REST endpoints.

### Fixed

- Path parameters for file APIs moved to request body to avoid URL encoding/special-char issues and path-traversal risks in routing.
