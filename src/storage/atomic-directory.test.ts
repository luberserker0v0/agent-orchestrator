import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replaceDirectorySync } from './atomic-directory.js';

describe('replaceDirectorySync', () => {
  let directory: string;
  let target: string;

  beforeEach(() => {
    directory = join(tmpdir(), `atomic-directory-test-${Date.now()}-${Math.random()}`);
    target = join(directory, 'skill');
    mkdirSync(directory, { recursive: true });
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('installs a fully populated new directory', () => {
    replaceDirectorySync(target, staging => {
      writeFileSync(join(staging, 'SKILL.md'), '# skill');
    });

    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('# skill');
    expect(readdirSync(directory)).toEqual(['skill']);
  });

  it('replaces the entire prior tree without retaining stale files', () => {
    mkdirSync(target);
    writeFileSync(join(target, 'old.txt'), 'old');

    replaceDirectorySync(target, staging => {
      writeFileSync(join(staging, 'SKILL.md'), 'new');
    });

    expect(existsSync(join(target, 'old.txt'))).toBe(false);
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('new');
    expect(readdirSync(directory)).toEqual(['skill']);
  });

  it('preserves the prior directory when staging fails', () => {
    mkdirSync(target);
    writeFileSync(join(target, 'SKILL.md'), 'old');

    expect(() => replaceDirectorySync(target, staging => {
      writeFileSync(join(staging, 'SKILL.md'), 'partial');
      throw new Error('copy failed');
    })).toThrow('copy failed');

    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('old');
    expect(readdirSync(directory)).toEqual(['skill']);
  });

  it('rejects replacement of a symbolic-link destination', () => {
    const outside = join(directory, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'SKILL.md'), 'outside');
    symlinkSync(outside, target, process.platform === 'win32' ? 'junction' : 'dir');

    expect(() => replaceDirectorySync(target, staging => {
      writeFileSync(join(staging, 'SKILL.md'), 'replacement');
    })).toThrow('symbolic links');

    expect(readFileSync(join(outside, 'SKILL.md'), 'utf8')).toBe('outside');
  });
});
