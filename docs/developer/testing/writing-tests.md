# Writing Tests

This guide covers patterns for writing unit and E2E tests.

## Unit Test Template

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MyService } from './my-service.js';
import { MockDependency } from '../__mocks__/dependency.js';

describe('MyService', () => {
  let service: MyService;
  let mockDep: MockDependency;

  beforeEach(() => {
    mockDep = new MockDependency();
    service = new MyService(mockDep);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('methodName', () => {
    it('should handle normal case', async () => {
      mockDep.fetch.mockResolvedValue({ data: 'test' });
      
      const result = await service.methodName('input');
      
      expect(result).toBe('expected output');
      expect(mockDep.fetch).toHaveBeenCalledWith('input');
    });

    it('should handle error case', async () => {
      mockDep.fetch.mockRejectedValue(new Error('Network error'));
      
      await expect(service.methodName('input')).rejects.toThrow('Network error');
    });

    it('should handle edge case', () => {
      expect(service.methodName('')).toBe('');
      expect(service.methodName(null)).toBeNull();
    });
  });
});
```

## E2E Test Template

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestServer, TestServer, generateId } from '../helpers.js';

describe('Feature Name', () => {
  let server: TestServer;
  let baseUrl: string;
  let conversationId: string;

  beforeAll(async () => {
    server = await createTestServer({ port: 0 });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(async () => {
    // Create a fresh conversation for each test
    const res = await fetch(`${baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    conversationId = data.id;
  });

  it('should perform action', async () => {
    const res = await fetch(`${baseUrl}/api/conversations/${conversationId}/start`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
  }, 60000);
});
```

## Helper Functions

### createTestServer

```typescript
interface TestServer {
  port: number;
  stop: () => Promise<void>;
}

async function createTestServer(options?: { port?: number }): Promise<TestServer> {
  // Start server with test config
  // Return port and stop function
}
```

### generateId

```typescript
function generateId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
```

## Mocking Patterns

### HTTP Client Mock

```typescript
vi.mock('../opencode-http/client.js', () => ({
  OpenCodeClient: vi.fn().mockImplementation(() => ({
    healthCheck: vi.fn().mockResolvedValue(true),
    createSession: vi.fn().mockResolvedValue({ id: 'session-1' }),
    sendMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
  })),
}));
```

### Process Spawn Mock

```typescript
vi.mock('cross-spawn', () => ({
  default: vi.fn().mockReturnValue({
    pid: 12345,
    kill: vi.fn(),
    on: vi.fn(),
  }),
}));
```

### File System Mock

```typescript
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('file content'),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));
```

## Test Data

### Creating Test Fixtures

```typescript
function createConversationFixture(overrides?: Partial<ConversationData>) {
  return {
    id: generateId(),
    agentType: 'opencode-direct',
    status: 'prepared',
    ready: false,
    needsRestart: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}
```

### Cleaning Up

```typescript
afterEach(async () => {
  // Clean up test data
  await server.cleanup();
});
```

## Code Style Rules

1. **No `any` in tests** — Use proper types even in mocks
2. **Descriptive test names** — `should handle empty input` not `test1`
3. **One concept per test** — Don't test multiple behaviors in one `it`
4. **Use `beforeEach` for setup** — Not inside each test
5. **Clean up in `afterEach`** — Prevent test pollution
6. **Mock at the boundary** — Mock external dependencies, not internal functions
7. **Test error paths** — Don't just test happy paths
8. **Use `expect.assertions`** — For async error tests
