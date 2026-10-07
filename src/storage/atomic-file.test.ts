import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFile, atomicWriteFileSync } from './atomic-file.js';

describe('atomic file writes', () => {
  let directory: string;

  beforeEach(() => {
    directory = join(tmpdir(), `atomic-file-test-${Date.now()}-${Math.random()}`);
    mkdirSync(directory, { recursive: true });
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('atomically replaces text and binary files', async () => {
    const syncPath = join(directory, 'sync.txt');
    const asyncPath = join(directory, 'async.bin');
    writeFileSync(syncPath, 'old');

    atomicWriteFileSync(syncPath, 'new');
    await atomicWriteFile(asyncPath, Buffer.from([0, 1, 2]));

    expect(readFileSync(syncPath, 'utf8')).toBe('new');
    expect(readFileSync(asyncPath)).toEqual(Buffer.from([0, 1, 2]));
    expect(readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('preserves existing permissions and restricts new files', async () => {
    const existingPath = join(directory, 'existing.json');
    const newPath = join(directory, 'new.json');
    writeFileSync(existingPath, '{}', { mode: 0o640 });
    chmodSync(existingPath, 0o640);

    atomicWriteFileSync(existingPath, '{"updated":true}');
    await atomicWriteFile(newPath, '{}');

    expect(statSync(existingPath).mode & 0o777).toBe(0o640);
    expect(statSync(newPath).mode & 0o777).toBe(0o600);
  });

  it('removes the temporary file when replacement fails', () => {
    const targetDirectory = join(directory, 'destination');
    mkdirSync(targetDirectory);

    expect(() => atomicWriteFileSync(targetDirectory, 'content')).toThrow();
    expect(readdirSync(directory)).toEqual(['destination']);
  });
});
