# Developer Setup

Get the development environment running in 5 minutes.

## 1. Clone and Install

```bash
git clone https://github.com/luberserker0v0/agent-orchestrator.git
cd agent-orchestrator
npm install
```

## 2. Install Git Hooks

```bash
node scripts/setup-hooks.js
```

This installs:
- **pre-commit:** Runs `npm run lint`
- **pre-push:** Runs `npm run preflight` (lint + test + build)

## 3. Copy Config

```bash
cp config/agentorchestrator.example.json config/agentorchestrator.json
```

## 4. Start Development Server

```bash
npm run dev
```

The server starts with hot-reload. Changes to `src/` automatically restart the server.

## 5. Verify

```bash
# Health check
curl http://localhost:8080/health

# Run tests
npm run test

# Run linter
npm run lint

# Build
npm run build
```

## Common Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with hot-reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run production build |
| `npm run test` | Run all unit tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with coverage |
| `npm run lint` | Check code style |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm run preflight` | Run lint + test + build |

## E2E Testing

```bash
# Docker runtime (default)
npm run test:e2e

# Direct runtime (requires local opencode)
npm run test:e2e:direct

# Runtime-specific tests
npm run test:e2e:runtime

# Watch mode
npm run test:e2e:watch
```

See [Testing Guide](testing/) for details.

## Troubleshooting

### Port Already in Use

```bash
# Find process on port 8080
lsof -i :8080

# Use different port
npm run dev -- --port 9090
```

### TypeScript Errors

```bash
# Clean build
rm -rf dist/
npm run build
```

### Test Failures

```bash
# Run specific test file
npx vitest run src/services/conversation-service.test.ts

# Run with verbose output
npx vitest run --reporter=verbose
```
