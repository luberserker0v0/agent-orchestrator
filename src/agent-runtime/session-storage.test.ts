import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveSessionStorage, sanitizeSessionId } from './session-storage.js';

describe('sanitizeSessionId', () => {
  it('replaces path separators', () => {
    expect(sanitizeSessionId('a/b\\c')).toBe('a_b_c');
  });

  it('collapses dot-dot sequences', () => {
    expect(sanitizeSessionId('../evil')).toBe('__evil');
  });

  it('leaves plain ids untouched', () => {
    expect(sanitizeSessionId('conv-123')).toBe('conv-123');
  });
});

describe('resolveSessionStorage', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ao-session-storage-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates per-conversation dir and maps XDG_DATA_HOME in xdg mode', () => {
    const result = resolveSessionStorage({ sharedRoot: root }, 'conv-1');
    expect(result.sessionDir).toBe(join(resolve(root), 'conv-1'));
    expect(existsSync(result.sessionDir)).toBe(true);
    expect(result.env).toEqual({ XDG_DATA_HOME: result.sessionDir });
  });

  it('adds OPENCODE_DB in sqlite mode', () => {
    const result = resolveSessionStorage({ sharedRoot: root, mode: 'sqlite' }, 'conv-2');
    expect(result.env).toEqual({
      XDG_DATA_HOME: result.sessionDir,
      OPENCODE_DB: join(result.sessionDir, 'opencode.db'),
    });
  });

  it('sanitizes hostile conversation ids', () => {
    const result = resolveSessionStorage({ sharedRoot: root }, '../../evil');
    expect(result.sessionDir).toBe(join(resolve(root), '____evil'));
    expect(existsSync(result.sessionDir)).toBe(true);
  });

  it('resolves relative roots against cwd', () => {
    const result = resolveSessionStorage({ sharedRoot: 'relative-root-test' }, 'conv-3');
    expect(result.sessionDir).toBe(join(resolve(process.cwd(), 'relative-root-test'), 'conv-3'));
    rmSync(join(resolve(process.cwd(), 'relative-root-test')), { recursive: true, force: true });
  });
});
