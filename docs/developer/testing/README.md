# Testing Guide

AgentOrchestrator uses a three-tier testing strategy.

## Test Tiers

| Tier | Scope | Speed | Tool | Config |
|------|-------|-------|------|--------|
| **Unit** | Individual functions/classes | Fast (< 1s) | Vitest | `vitest.config.ts` |
| **E2E** | Full API workflows | Slow (10-60s) | Vitest | `e2e/vitest.config.e2e.ts` |
| **Runtime** | Container lifecycle | Slow (30-120s) | Vitest | `e2e/vitest.config.runtime.ts` |

## Running Tests

```bash
# Unit tests
npm run test

# Unit tests (watch mode)
npm run test:watch

# Unit tests with coverage
npm run test:coverage

# E2E tests (Docker runtime)
npm run test:e2e

# E2E tests (Direct runtime)
npm run test:e2e:direct

# Runtime-specific tests
npm run test:e2e:runtime

# E2E tests (watch mode)
npm run test:e2e:watch

# Full preflight (lint + test + build)
npm run preflight
```

## Coverage Thresholds

| Metric | Threshold |
|--------|-----------|
| Lines | 70% |
| Functions | 75% |
| Branches | 55% |
| Statements | 65% |

## Test Structure

```
src/
  services/
    conversation-service.ts        # Source
    conversation-service.test.ts   # Unit tests

e2e/
  scenarios/
    lifecycle/
      lifecycle.e2e.test.ts        # E2E tests
    orchestrator/
      orchestrator.e2e.test.ts
    workspace/
      workspace.e2e.test.ts
    runtime/
      direct-runtime.test.ts
      docker-runtime.test.ts
```

## Test Naming

```typescript
// Unit: describe('ClassName') or describe('functionName')
describe('PortPool', () => {
  it('should allocate available port', () => { ... });
  it('should throw when pool is exhausted', () => { ... });
});

// E2E: describe('feature area')
describe('Conversation Lifecycle', () => {
  it('should create, start, and delete conversation', () => { ... });
});
```

## CI Integration

Tests run automatically in GitHub Actions:

1. `npm ci` — Install dependencies
2. `npm run preflight` — Lint + test + build
3. `npm run test:coverage` — Coverage report
4. Upload coverage artifact

See [Writing Tests](writing-tests.md) for patterns and examples.
