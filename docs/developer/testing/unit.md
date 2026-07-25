# Unit Tests

Unit tests validate individual functions and classes in isolation.

## Running

```bash
npm run test                    # Run all
npm run test:watch              # Watch mode
npm run test:coverage           # With coverage
npx vitest run src/utils/logger.test.ts  # Single file
```

## Pattern

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PortPool } from './port-pool.js';

describe('PortPool', () => {
  let pool: PortPool;

  beforeEach(() => {
    pool = new PortPool({ start: 30000, end: 30002 });
  });

  it('should allocate first available port', () => {
    expect(pool.allocate()).toBe(30000);
  });

  it('should allocate ports sequentially', () => {
    expect(pool.allocate()).toBe(30000);
    expect(pool.allocate()).toBe(30001);
    expect(pool.allocate()).toBe(30002);
  });

  it('should throw when pool is exhausted', () => {
    pool.allocate();
    pool.allocate();
    pool.allocate();
    expect(() => pool.allocate()).toThrow('No available ports');
  });

  it('should release port back to pool', () => {
    const port = pool.allocate();
    pool.release(port);
    expect(pool.allocate()).toBe(port);
  });
});
```

## Mocking

### Mock Functions

```typescript
const mockFn = vi.fn();
mockFn.mockReturnValue('value');
expect(mockFn).toHaveBeenCalledWith(expectedArg);
```

### Mock Modules

```typescript
vi.mock('./config-loader.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({ server: { port: 8080 } }),
}));
```

### Mock Classes

```typescript
class MockRuntime implements Runtime {
  spawn = vi.fn().mockResolvedValue({ pid: 123, port: 30000 });
  kill = vi.fn().mockResolvedValue(undefined);
  healthCheck = vi.fn().mockResolvedValue(true);
}
```

### Spying

```typescript
const spy = vi.spyOn(service, 'method');
await service.doSomething();
expect(spy).toHaveBeenCalled();
```

## Testing Async Code

```typescript
it('should handle async operation', async () => {
  const result = await service.asyncMethod();
  expect(result).toBeDefined();
});

it('should reject on error', async () => {
  await expect(service.failingMethod()).rejects.toThrow('Error message');
});
```

## Testing Errors

```typescript
it('should throw AppError', () => {
  expect(() => service.invalidOperation()).toThrow('Invalid operation');
});

it('should throw with specific code', () => {
  try {
    service.invalidOperation();
    expect.fail('Should have thrown');
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(NOT_FOUND);
  }
});
```

## Best Practices

1. **One assertion per concept** — Each `it` block tests one behavior
2. **Descriptive names** — Test name describes the expected behavior
3. **Arrange-Act-Assert** — Clear structure in each test
4. **Isolate tests** — Use `beforeEach` to reset state
5. **Mock external dependencies** — Don't call real APIs or spawn processes
6. **Test edge cases** — Empty inputs, boundary values, errors
