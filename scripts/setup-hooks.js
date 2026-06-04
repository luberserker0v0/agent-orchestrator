#!/usr/bin/env node
/**
 * Git Hooks Setup Script
 *
 * Usage: node scripts/setup-hooks.js
 *
 * Installs pre-commit and pre-push hooks into .git/hooks/
 * - pre-commit: runs `npm run lint` before every commit
 * - pre-push: runs `npm run test` before every push
 */

import { writeFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const hooksDir = join(rootDir, '.git', 'hooks');

if (!existsSync(hooksDir)) {
  mkdirSync(hooksDir, { recursive: true });
}

const preCommitHook = `#!/bin/sh
# Auto-generated pre-commit hook
# Runs lint before every commit

echo "[pre-commit] Running lint..."
npm run lint
if [ $? -ne 0 ]; then
  echo "[pre-commit] Lint failed. Commit aborted."
  exit 1
fi
`;

const prePushHook = `#!/bin/sh
# Auto-generated pre-push hook
# Runs full verification pipeline before every push

echo "[pre-push] Running preflight (lint + test + build)..."
npm run preflight
if [ $? -ne 0 ]; then
  echo "[pre-push] Preflight failed. Push aborted."
  exit 1
fi
`;

const preCommitPath = join(hooksDir, 'pre-commit');
const prePushPath = join(hooksDir, 'pre-push');

writeFileSync(preCommitPath, preCommitHook, { encoding: 'utf-8' });
writeFileSync(prePushPath, prePushHook, { encoding: 'utf-8' });

// Make executable on Unix-like systems (no-op on Windows)
try {
  chmodSync(preCommitPath, 0o755);
  chmodSync(prePushPath, 0o755);
} catch {
  // Ignore chmod errors on Windows
}

console.log('Git hooks installed successfully:');
console.log('  - .git/hooks/pre-commit  (runs npm run lint)');
console.log('  - .git/hooks/pre-push    (runs npm run test)');
console.log('');
console.log('To bypass hooks in emergencies:');
console.log('  git commit --no-verify');
console.log('  git push --no-verify');
