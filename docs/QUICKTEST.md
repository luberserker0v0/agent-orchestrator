# Quick Test Guide

How to run and write tests for AgentOrchestrator.

---

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
  helpers/
    server.ts           Spins up a real AgentOrchestrator server per test file
    ws.ts               WebSocket JSON-RPC 2.0 client helper
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

Fill in at minimum:
- `AO_TEST_PROVIDER_BASE_URL` — your OpenAI-compatible provider endpoint
- `AO_TEST_PROVIDER_MODELS` — comma-separated model names available on your provider

3. For **Docker runtime** tests:
   - Docker must be installed and running
   - Pull the OpenCode image: `docker pull ghcr.io/anomalyco/opencode`

### Run all e2e tests

```bash
npm run test:e2e
```

This runs three groups sequentially:
1. `test:e2e:workspace` — agent CRUD, file CRUD (always `direct` runtime)
2. `test:e2e:direct` — lifecycle tests with `direct` runtime
3. `test:e2e:docker` — lifecycle tests with `docker` runtime

### Run specific e2e group

```bash
# Workspace operations (no OpenCode instance needed)
npm run test:e2e:workspace

# Lifecycle with direct runtime
npm run test:e2e:direct

# Lifecycle with Docker runtime
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
