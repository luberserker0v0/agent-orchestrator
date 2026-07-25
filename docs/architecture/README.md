# Architecture Overview

AgentOrchestrator manages OpenCode AI coding agent instances and exposes REST + WebSocket APIs for external integrations. This document describes the system's layered architecture, core modules, and instance lifecycle.

## System Layers

```
┌─────────────────────────────────────────────────────────────┐
│                     Client Layer                             │
│  HTTP Clients (curl)    WebSocket Clients (wscat, Dashboard)│
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                    Transport Layer                           │
│  HTTP Server (Express 5)    WebSocket Router (JSON-RPC 2.0) │
│  Auth Middleware (RBAC)     SSE Event Forwarding             │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                   Service Layer                              │
│  ConversationService    ConfigService    SkillService        │
│  MessageService         AgentService     FileService         │
│  SessionService         RoleService      (planned)           │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                  Domain Layer                                │
│  ConversationState      InstanceManager   SSEBridge          │
│  PortPool               WorkspaceFactory  Metrics            │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│              Runtime Abstraction Layer                       │
│  RuntimeRegistry    RuntimeManager    RuntimeFactory         │
│  ┌──────────────┐  ┌──────────────┐                        │
│  │ DirectRuntime│  │ DockerRuntime│  (extensible)           │
│  └──────────────┘  └──────────────┘                        │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                  External Services                           │
│  OpenCode CLI (child process or Docker container)            │
└─────────────────────────────────────────────────────────────┘
```

## Core Principles

1. **Layered Separation** — Each layer has a single responsibility; upper layers call lower layers, never the reverse.
2. **Runtime Abstraction** — The system supports multiple ways to spawn OpenCode (direct process, Docker container) through a common `Runtime` interface.
3. **Event-Driven State** — `ConversationState` is the single source of truth. All state changes emit events that are pushed to WebSocket clients and optionally forwarded via SSE.
4. **Config-Driven Everything** — All behavior (ports, timeouts, instance limits, auth) is configurable via a single JSONC file with env var overrides.
5. **Graceful Lifecycle** — Instances have a well-defined state machine with transitions for start, stop, restart, error, and idle timeout.

## Key Documents

| Document | Description |
|----------|-------------|
| [Data Flows](data-flows.md) | Step-by-step request/response sequences |
| [Security](security.md) | Authentication, authorization, and RBAC model |
| [Modules Reference](modules.md) | All core modules with method tables |
| [API Reference](../user/api/) | REST, WebSocket, and SSE API documentation |
| [Configuration](../user/configuration/) | All config fields and overrides |
| [Deployment](../user/deployment/) | Docker, npm, and source deployment |
