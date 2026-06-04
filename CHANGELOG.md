# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial release of AgentOrchestrator.
- Per-conversation OpenCode instance orchestration with process-level isolation.
- Dynamic workspace creation with sandboxed permissions via `opencode.json`.
- REST API for conversation lifecycle management (`POST`, `DELETE`, `GET /api/conversations`).
- WebSocket API with JSON-RPC 2.0 for real-time messaging (`message.send`, `message.history`, `session.abort`).
- Dynamic port allocation and LRU eviction for OpenCode instances.
- Automatic Basic Auth password generation per instance.
- Model selection per conversation via `POST /api/conversations` and WebSocket overrides.
- `GET /api/models` endpoint powered by `opencode models` CLI.
- Cross-platform process spawning and cleanup via `cross-spawn` and `tree-kill`.
- Configuration loader with environment variable override support.
