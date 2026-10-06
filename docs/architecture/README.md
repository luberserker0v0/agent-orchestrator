# Architecture Overview

AgentOrchestrator manages OpenCode AI coding agent instances and exposes REST
and WebSocket APIs for external integrations. The runtime abstraction keeps the
API and lifecycle model consistent while changing where OpenCode executes.

## System Layers

```mermaid
flowchart TB
    subgraph Clients[Client layer]
        CLI[aor CLI and HTTP clients]
        UI[Dashboard]
        WS[WebSocket clients]
    end

    subgraph Transport[Transport layer]
        HTTP[Express REST API]
        Socket[JSON-RPC WebSocket router]
        Auth[Authentication and RBAC]
    end

    subgraph Services[Service layer]
        Conversation[Conversation and session services]
        Content[Message, file, agent, and skill services]
        Admin[Role, cleanup, and configuration services]
    end

    subgraph Domain[Domain and lifecycle]
        State[Conversation state]
        Manager[Instance manager]
        Workspace[Workspace factory]
        Events[SSE bridge and metrics]
    end

    subgraph Runtimes[Runtime abstraction]
        Factory[Registry and runtime factory]
        Direct[Direct runtime]
        Docker[Docker runtime]
        Kubernetes[Kubernetes runtime]
        Factory --> Direct
        Factory --> Docker
        Factory --> Kubernetes
    end

    CLI --> Auth
    UI --> Auth
    WS --> Auth
    Auth --> HTTP
    Auth --> Socket
    HTTP --> Conversation
    HTTP --> Content
    HTTP --> Admin
    Socket --> Conversation
    Conversation --> State
    Content --> Workspace
    Admin --> Workspace
    State --> Manager
    Manager --> Factory
    Manager --> Events
    Direct --> DirectInstance[OpenCode host process]
    Docker --> DockerInstance[OpenCode container]
    Kubernetes --> KubeAPI[Kubernetes API]
    KubeAPI --> KubeInstance[OpenCode Pod and Service]
    KubeAPI --> Volume[Per-conversation PVC]
    Operator[Placement operator] <--> KubeAPI
    DirectInstance --> LLM[LLM provider]
    DockerInstance --> LLM
    KubeInstance --> LLM
```

## Core Principles

1. **Layered separation** — Each layer has a focused responsibility; upper
   layers use lower layers through defined interfaces.
2. **Runtime abstraction** — A common runtime interface supports a direct host
   process, Docker container, or Kubernetes Pod per active conversation.
3. **Event-driven state** — `ConversationState` is the lifecycle source of
   truth. State changes emit events to WebSocket clients and metrics.
4. **Config-driven operation** — Ports, limits, authentication, storage,
   cleanup, logging, and runtime behavior come from one validated JSONC config.
5. **Graceful lifecycle** — Start, stop, restart, migrate, idle eviction, and
   delete have explicit transitions and preserve or remove data intentionally.
6. **Ownership-safe cleanup** — Managed persistent artifacts carry installation
   ownership and generation metadata; foreign artifacts are report-only.

## Deployment Shapes

| Shape | AgentOrchestrator | OpenCode | Persistent state |
|-------|-------------------|----------|------------------|
| [Direct](../user/setup/direct.md) | Host Node.js process | Host child process | Local workspace and managed session directories |
| [Docker](../user/setup/docker.md) | Container | Bundled child process, or optional Docker runtime | Named volumes |
| [Kubernetes](../user/setup/kubernetes.md) | Deployment | Per-conversation Pod and Service | Workspace PVC plus per-conversation PVCs |

## Key Documents

| Document | Description |
|----------|-------------|
| [Data Flows](data-flows.md) | Step-by-step request/response sequences |
| [Security](security.md) | Authentication, authorization, and RBAC model |
| [Modules Reference](modules.md) | Core modules and method tables |
| [Setup Tutorials](../user/setup/) | Direct, Docker, and Kubernetes end-to-end procedures |
| [API Reference](../user/api/) | REST, WebSocket, and SSE API documentation |
| [Configuration](../user/configuration/) | Configuration fields and overrides |
| [Deployment](../user/deployment/) | Production operations references |
