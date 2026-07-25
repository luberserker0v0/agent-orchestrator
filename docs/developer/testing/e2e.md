# E2E Tests

End-to-end tests validate complete API workflows against a running server.

## Prerequisites

- **Docker runtime tests:** Docker daemon running
- **Direct runtime tests:** OpenCode CLI installed

## Running

```bash
# Docker runtime (default)
npm run test:e2e

# Direct runtime
npm run test:e2e:direct

# Runtime-specific tests
npm run test:e2e:runtime

# Watch mode
npm run test:e2e:watch

# Single file
npx vitest run --config e2e/vitest.config.e2e.ts e2e/scenarios/lifecycle/lifecycle.e2e.test.ts
```

## Test Categories

| Directory | What it tests | Runtime |
|-----------|--------------|---------|
| `e2e/scenarios/lifecycle/` | HTTP/WS conversation lifecycle | Any (Docker default) |
| `e2e/scenarios/orchestrator/` | LRU eviction, idle timeout, crash recovery | Any (Docker default) |
| `e2e/scenarios/workspace/` | File/agent CRUD, path traversal protection | Any (Docker default) |
| `e2e/scenarios/runtime/direct-runtime.test.ts` | Process spawn, env vars, SIGTERM | Direct only |
| `e2e/scenarios/runtime/docker-runtime.test.ts` | Container lifecycle, port mapping | Docker only |

## Pattern

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestServer, TestServer } from '../helpers.js';

describe('Conversation Lifecycle', () => {
  let server: TestServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = await createTestServer({ port: 0 });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('should create conversation', async () => {
    const res = await fetch(`${baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBeDefined();
    expect(data.status).toBe('prepared');
  });
});
```

## WebSocket E2E

```typescript
import WebSocket from 'ws';

describe('WebSocket Events', () => {
  it('should receive events', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/${conversationId}`);
    
    const events: unknown[] = [];
    ws.on('message', (data) => {
      events.push(JSON.parse(data.toString()));
    });

    // Trigger an action
    await fetch(`${baseUrl}/api/conversations/${conversationId}/start`, {
      method: 'POST',
    });

    // Wait for events
    await new Promise((resolve) => setTimeout(resolve, 2000));
    
    expect(events.some(e => e.type === 'conversation.running')).toBe(true);
    ws.close();
  });
});
```

## Timeouts

E2E tests have longer timeouts due to process spawning:

```typescript
it('should start instance', async () => {
  // This may take 10-30 seconds
  const res = await fetch(`${baseUrl}/api/conversations/${id}/start`, {
    method: 'POST',
  });
  expect(res.status).toBe(200);
}, 60000); // 60 second timeout
```

## Debugging

### View Server Logs

E2E tests start a server with logs enabled. Check the test output for log messages.

### Manual Testing

```bash
# Start server in dev mode
npm run dev

# Test endpoints manually
curl -X POST http://localhost:8080/api/conversations -H "Content-Type: application/json" -d '{}'
```

### Container Debugging

```bash
# List running containers
docker ps | grep opencode

# View container logs
docker logs <container-name>

# Exec into container
docker exec -it <container-name> sh
```

## CI Behavior

- E2E tests run with Docker runtime by default
- Direct runtime tests are skipped unless `E2E_RUNTIME=direct` is set
- Runtime-specific tests use `describe.skipIf` to skip when unavailable
