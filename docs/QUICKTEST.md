> **DEPRECATED**: This file has been reorganized. See [new documentation](developer/testing/) for the updated testing guide. This file will be removed in a future version.

# Quick Test Guide

How to run and write tests for AgentOrchestrator.

---

## Testing Strategy

AgentOrchestrator follows a **three-tier testing strategy**:

| Tier | Scope | Speed | Purpose |
|------|-------|-------|---------|
| **Unit tests** | `src/**/*.test.ts` | ~2-3s per run | Validate individual modules with mocked dependencies |
| **Integration tests** | Unit tests + real config loading | ~2-3s | Verify module interactions (covered within unit test suite) |
| **E2E tests** | `e2e/**/*.test.ts` | 60-120s per run | Full stack with real OpenCode instances |

**Key principles:**
- Unit tests mock all external I/O (filesystem, network, subprocesses) — currently **755 unit tests** covering all service, domain, and transport layers
- E2E tests are **runtime-agnostic** — same scenarios run against both `direct` and `docker` runtimes
- Every runtime config addition (e.g. `instanceHost`, `networkMode`) includes unit tests for config validation + runtime behavior
- Shared utilities (e.g. `waitForHealthy`) have focused unit tests for retry logic, timeout, and edge cases

## Test Structure

```
src/                    Unit tests (co-located with source, *.test.ts)
  orchestrator/
    port-pool.test.ts
    instance-manager.test.ts
    ...
  websocket/
    router.test.ts
    connection.test.ts
  http-api/
    server.test.ts
  ...

e2e/                    End-to-end tests (real OpenCode instances)
  scenarios/
    lifecycle/          conversation lifecycle, message send, ready-state
    workspace/          agent CRUD, file CRUD
    orchestrator/       process crash, idle timeout, LRU eviction
  helpers/
    server.ts           Spins up a real AgentOrchestrator server per test file
    ws.ts               WebSocket JSON-RPC 2.0 client helper
    process.ts          Platform-aware process find/kill utilities
```

---

## Unit Tests

Run all unit tests:

```bash
npm test
```

Watch mode (re-runs on file changes):

```bash
npm run test:watch
```

With coverage report:

```bash
npm run test:coverage
```

Coverage thresholds (enforced in `vitest.config.ts`):
| Metric    | Minimum |
|-----------|---------|
| Lines     | 70%     |
| Functions | 75%     |
| Branches  | 55%     |
| Statements| 65%     |

Run a single test file:

```bash
npx vitest run src/orchestrator/port-pool.test.ts
```

---

## E2E Tests

E2E tests spawn real OpenCode instances and the full AgentOrchestrator stack.

### Prerequisites

1. **OpenCode CLI** must be installed (`opencode --version`)
2. **`.env.test`** — copy from `.env.test.example` and configure:

```bash
cp .env.test.example .env.test
```

The default config in `src/test-fixtures/opencode.example.json` uses a hardcoded provider — update `.env.test` only if you need custom Docker or server overrides.

3. For **Docker runtime** tests:
   - Docker must be installed and running
    - Pull the OpenCode image: `docker pull ghcr.io/anomalyco/opencode:1.17.4`

### Run all e2e tests

```bash
npm run test:e2e
```

This runs two groups sequentially:
1. `test:e2e:direct` — lifecycle + workspace tests with `direct` runtime
2. `test:e2e:docker` — lifecycle + workspace tests with `docker` runtime

### Run specific e2e group

```bash
# All e2e with direct runtime (includes workspace + lifecycle)
npm run test:e2e:direct

# All e2e with Docker runtime (includes workspace + lifecycle)
npm run test:e2e:docker
```

### Run a single e2e test file

```bash
npx vitest run --config e2e/vitest.config.e2e.ts \
  e2e/scenarios/workspace/file-crud.test.ts
```

### Timeout notes

| Runtime | Test timeout | Hook timeout |
|---------|-------------|--------------|
| direct  | 60s         | 30s          |
| docker  | 120s        | 60s          |

E2E tests are **not** included in `npm run preflight` — run them manually.

---

## Writing Tests

### Unit test pattern

```ts
// src/orchestrator/port-pool.test.ts
import { describe, it, expect } from 'vitest';
import { PortPool } from './port-pool.js';

describe('PortPool', () => {
  it('allocates and releases ports', () => {
    const pool = new PortPool(30000, 30005);
    const port = pool.allocate();
    expect(port).toBe(30000);
    pool.release(port!);
    expect(pool.getUsedCount()).toBe(0);
  });
});
```

### E2E test pattern

```ts
// e2e/scenarios/workspace/file-crud.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, type E2EServer } from '../../helpers/server.js';

describe('File CRUD (E2E)', () => {
  let server: E2EServer;

  beforeAll(async () => {
    server = await startServer();
  }, 30_000);

  afterAll(async () => {
    await server.cleanup();
  }, 15_000);

  it('writes a file', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations/e2e-files/files`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'test/hello.txt', content: 'Hello!' }),
    });
    expect(res.status).toBe(204);
  });
});
```

### WebSocket e2e pattern

```ts
import { createWSClient } from '../../helpers/ws.js';

const ws = await createWSClient('ws://127.0.0.1:11697/ws/demo');
const res = await ws.request('message.send', { text: 'Hello' });
expect(res.result).toBeDefined();
ws.close();
```

### Code style rules for tests

- File naming: `*.test.ts` co-located with source (units), or under `e2e/scenarios/` (e2e)
- Prefer `describe`/`it` over `test`
- Use `beforeAll`/`afterAll` for setup/teardown
- Always clean up resources in `afterAll` (close servers, kill processes, remove temp dirs)
- E2E tests should use `startServer()` from `e2e/helpers/server.ts` — it auto-assigns ports and handles cleanup
- Avoid mocking external commands in e2e tests (they test real integrations)

---

## Preflight

Before committing, run the full verification pipeline:

```bash
npm run preflight
```

This runs: **lint → unit test → build**. 0 lint errors, all tests passing, clean TypeScript compilation required.

E2E tests are manual and not part of preflight.

---

## k8s Integration Testing Strategy

For teams deploying AgentOrchestrator on Kubernetes, use this testing approach:

### Container-level validation (pre-deploy)

```bash
# Build the orchestrator image
docker build -t agent-orchestrator:test .

# Start with local config volume
docker run -d --name aor-test \
  -p 18080:8080 \
  -v $(pwd)/config:/app/config \
  agent-orchestrator:test

# Run smoke test
curl -s http://localhost:18080/health

# Clean up
docker rm -f aor-test
```

### k8s manifest validation

```bash
# Validate generated manifests
kubectl apply --dry-run=server -f k8s/deployment.yaml
kubectl apply --dry-run=server -f k8s/service.yaml

# Deploy to test namespace
kubectl -n aor-test apply -f k8s/
```

### E2E against k8s deployment

```bash
# Forward the service port
kubectl -n aor-test port-forward svc/agent-orchestrator 8080:8080 &

# Point test suite at the k8s endpoint
AO_BASE_URL=http://localhost:8080 npx vitest run --config e2e/vitest.config.e2e.ts
```

### Recommended k8s health checks (for deployment manifests)

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 8080
  initialDelaySeconds: 10
  periodSeconds: 30
readinessProbe:
  httpGet:
    path: /health
    port: 8080
  initialDelaySeconds: 5
  periodSeconds: 10
```

### Configuration via ConfigMap

Mount `config/agentorchestrator.json` as a k8s ConfigMap, override via environment variables in the Pod template.

> **Note**: Runtime-specific settings (`runtimes[].config.docker.*`, `instanceHost`) are only relevant when the orchestrator is configured to manage OpenCode instances on a Docker host (whether same-node or remote). The orchestrator itself does not require Docker to run.
