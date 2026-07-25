# Coding Standards

## TypeScript

- **Version:** ^6.0.3
- **Mode:** Strict (`"strict": true` in tsconfig.json)
- **Target:** ES2022
- **Module:** NodeNext

### Rules

- No `any` types (except in test mocks)
- No `@ts-ignore` or `@ts-expect-error` without explanation
- Explicit return types on exported functions
- Use `interface` for object shapes, `type` for unions/intersections
- Prefer `readonly` for immutable data

## ESLint

```bash
npm run lint        # Check
npm run lint:fix    # Auto-fix
```

### Key Rules

| Rule | Description |
|------|-------------|
| `@typescript-eslint/no-unused-vars` | Error (with `_` prefix allowed) |
| `@typescript-eslint/no-explicit-any` | Error |
| `no-console` | Warn (use logger instead) |
| `prefer-const` | Error |
| `eqeqeq` | Error |

**Note:** `*.test.ts` files may use `any` for mocks (existing warnings tolerated).

## Prettier

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2
}
```

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

<body>
```

### Types

| Type | Description |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation |
| `style` | Formatting (no code change) |
| `refactor` | Code restructuring |
| `test` | Adding/updating tests |
| `chore` | Build, CI, dependencies |

### Examples

```
feat(orchestrator): add LRU eviction for max instances
test(port-pool): add unit tests for allocation edge cases
fix(websocket): resolve heartbeat timeout handling
docs: restructure documentation
```

## Code Style

### Imports

```typescript
// Node.js built-ins first
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

// Third-party packages
import express from 'express';

// Internal modules (use .js extension for ESM)
import { loadConfig } from './config-loader.js';
import { logger } from '../utils/logger.js';
```

### Error Handling

```typescript
// Use AppError for application errors
import { AppError, NOT_FOUND } from '../utils/errors.js';

throw new AppError(404, NOT_FOUND, 'Conversation not found');

// Use try/catch for expected failures
try {
  await service.doSomething();
} catch (error) {
  logger.error('Operation failed', { error });
  throw new AppError(500, INTERNAL_ERROR, 'Operation failed');
}
```

### Logging

```typescript
import { logger } from '../utils/logger.js';

logger.info('Conversation started', { id, agentType });
logger.warn('Health check failed', { id, attempt });
logger.error('Instance spawn failed', { id, error: error.message });
```

**Never log:** API keys, passwords, tokens, secrets.

### Testing

```typescript
// Use describe/it/expect (Vitest globals)
import { describe, it, expect, vi } from 'vitest';

describe('PortPool', () => {
  it('should allocate available port', () => {
    const pool = new PortPool({ start: 30000, end: 30002 });
    const port = pool.allocate();
    expect(port).toBe(30000);
  });
});
```

## File Organization

- One class/interface per file (for non-trivial modules)
- Co-locate tests with source: `foo.ts` → `foo.test.ts`
- Group related functions in the same file
- Export types from the same file as the implementation

## Naming Conventions

| Element | Convention | Example |
|---------|------------|---------|
| Files | kebab-case | `conversation-state.ts` |
| Classes | PascalCase | `ConversationState` |
| Functions | camelCase | `loadConfig()` |
| Constants | camelCase | `DEFAULT_PORT` |
| Types | PascalCase | `ApiKeyEntry` |
| Interfaces | PascalCase | `Runtime` |
| Enums | PascalCase | (avoid; use string unions) |
