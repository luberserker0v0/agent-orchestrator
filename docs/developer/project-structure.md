# Project Structure

```
agent-orchestrator/
├── src/                          # Source code
│   ├── index.ts                  # Entry point
│   ├── cli.ts                    # CLI argument parsing
│   ├── config-loader.ts          # Configuration loading
│   │
│   ├── http-api/                 # HTTP layer
│   │   ├── server.ts             # Express 5 server, middleware
│   │   └── dashboard.ts          # Dashboard static file serving
│   │
│   ├── websocket/                # WebSocket layer
│   │   ├── connection.ts         # JSON-RPC 2.0 handler
│   │   └── router.ts             # WebSocket routing, auth
│   │
│   ├── services/                 # Business logic
│   │   ├── conversation-service.ts
│   │   ├── config-service.ts
│   │   ├── agent-service.ts
│   │   ├── message-service.ts
│   │   ├── file-service.ts
│   │   ├── session-service.ts
│   │   ├── skill-service.ts
│   │   └── role-service.ts       # (planned)
│   │
│   ├── orchestrator/             # Domain layer
│   │   ├── conversation-state.ts # State machine, events
│   │   ├── instance-manager.ts   # Instance lifecycle
│   │   ├── port-pool.ts          # Port allocation
│   │   ├── workspace-factory.ts  # Workspace management
│   │   └── sse-bridge.ts         # SSE event forwarding
│   │
│   ├── agent-runtime/            # Runtime abstraction
│   │   ├── types.ts              # Runtime interface
│   │   ├── registry.ts           # Runtime lookup
│   │   ├── runtime-manager.ts    # Instance management
│   │   └── runtimes/
│   │       ├── direct.ts         # Direct process spawn
│   │       └── docker.ts         # Docker container spawn
│   │
│   ├── opencode-cli/             # OpenCode CLI interaction
│   │   └── models.ts             # Model listing
│   │
│   ├── opencode-http/            # OpenCode HTTP client
│   │   ├── client.ts             # API client
│   │   └── types.ts              # API types
│   │
│   ├── metrics/                  # Prometheus metrics
│   │   └── registry.ts           # Metric definitions
│   │
│   └── utils/                    # Utilities
│       ├── logger.ts             # Structured logging
│       └── errors.ts             # Error codes, AppError
│
├── dashboard/                    # Built-in dashboard
│   └── index.html                # Single-file SPA
│
├── e2e/                          # End-to-end tests
│   ├── vitest.config.e2e.ts      # E2E config
│   ├── vitest.config.runtime.ts  # Runtime-specific config
│   └── scenarios/
│       ├── lifecycle/            # Conversation lifecycle
│       ├── orchestrator/         # Instance management
│       ├── workspace/            # File operations
│       └── runtime/              # Runtime-specific
│
├── config/                       # Configuration files
│   ├── agentorchestrator.json    # Main config
│   ├── agentorchestrator.example.json
│   └── canonical-opencode.json   # Canonical OpenCode config
│
├── scripts/                      # Build/setup scripts
│   ├── setup-hooks.js            # Git hooks installer
│   └── clean.js                  # Clean dist/
│
├── k8s/                          # Kubernetes (planned)
├── docs/                         # Documentation
├── .github/                      # GitHub Actions, templates
│
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── eslint.config.mjs
├── .nvmrc                        # Node.js version (24)
├── Dockerfile.template           # Docker build template
├── AGENTS.md                     # Development guide for AI agents
├── CHANGELOG.md
└── README.md
```

## File Naming Conventions

| Pattern | Example | Purpose |
|---------|---------|---------|
| `kebab-case.ts` | `conversation-state.ts` | Source files |
| `*.test.ts` | `conversation-state.test.ts` | Unit tests |
| `*.e2e.test.ts` | `lifecycle.e2e.test.ts` | E2E tests |
| `*.d.ts` | `types.d.ts` | Type declarations |

## Module Organization

### Service Layer (`src/services/`)
- One file per resource type
- Handles business logic
- Coordinates between domain objects and external APIs
- All mutating methods emit events

### Domain Layer (`src/orchestrator/`)
- Core state management
- Resource lifecycle
- Event emission
- No external API calls (except through injected clients)

### Runtime Abstraction (`src/agent-runtime/`)
- Pluggable runtime system
- Common `Runtime` interface
- Registry for runtime lookup
- Manager for instance lifecycle

### Transport Layer (`src/http-api/`, `src/websocket/`)
- HTTP and WebSocket handling
- Auth middleware
- Request/response transformation
- No business logic (delegates to services)
