import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FILE_LOG_ACTIVE_NAME,
  FILE_LOG_ROTATED_PATTERN,
  RollingFileSink,
  type FileLogOptions,
} from './rolling-file-sink.js';

const tempDirectories: string[] = [];

async function makeTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ao-file-log-'));
  tempDirectories.push(directory);
  return directory;
}

function options(directory: string, overrides: Partial<FileLogOptions> = {}): FileLogOptions {
  return {
    directory,
    maxFileSizeBytes: 1024,
    maxRotatedFiles: 10,
    retentionMs: 7 * 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

function rotatedName(index: number): string {
  return `agentorchestrator.2026-01-01T00-00-00-00${index}Z.123.${index}.jsonl`;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('RollingFileSink', () => {
  it('writes newline-delimited records and applies restrictive permissions', async () => {
    const directory = join(await makeTempDirectory(), 'nested', 'logs');
    const sink = new RollingFileSink(options(directory));

    await sink.initialize();
    sink.write(JSON.stringify({ sequence: 1 }));
    sink.write(JSON.stringify({ sequence: 2 }));
    await sink.flush();

    const contents = await readFile(join(directory, FILE_LOG_ACTIVE_NAME), 'utf8');
    expect(contents.trim().split('\n').map(line => JSON.parse(line))).toEqual([
      { sequence: 1 },
      { sequence: 2 },
    ]);

    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(directory, FILE_LOG_ACTIVE_NAME))).mode & 0o777).toBe(0o600);
    }
    await sink.close();
  });

  it('rotates before crossing the byte limit without splitting a record', async () => {
    const directory = await makeTempDirectory();
    const first = JSON.stringify({ message: 'a'.repeat(40) });
    const second = JSON.stringify({ message: 'b'.repeat(40) });
    const sink = new RollingFileSink(options(directory, {
      maxFileSizeBytes: Buffer.byteLength(`${first}\n`, 'utf8') + 1,
    }));

    await sink.initialize();
    sink.write(first);
    sink.write(second);
    await sink.flush();

    const names = await readdir(directory);
    const rotated = names.filter(name => FILE_LOG_ROTATED_PATTERN.test(name));
    expect(rotated).toHaveLength(1);
    expect((await readFile(join(directory, rotated[0]), 'utf8')).trim()).toBe(first);
    expect((await readFile(join(directory, FILE_LOG_ACTIVE_NAME), 'utf8')).trim()).toBe(second);
    await sink.close();
  });

  it('keeps an oversized record whole in an empty active file', async () => {
    const directory = await makeTempDirectory();
    const record = JSON.stringify({ message: 'x'.repeat(200) });
    const sink = new RollingFileSink(options(directory, { maxFileSizeBytes: 32 }));

    await sink.initialize();
    sink.write(record);
    await sink.flush();

    expect((await readFile(join(directory, FILE_LOG_ACTIVE_NAME), 'utf8')).trim()).toBe(record);
    expect((await readdir(directory)).filter(name => FILE_LOG_ROTATED_PATTERN.test(name))).toHaveLength(0);
    await sink.close();
  });

  it('drains writes accepted before close or reopen', async () => {
    const directory = await makeTempDirectory();
    const sink = new RollingFileSink(options(directory));
    await sink.initialize();

    sink.write('{"before":"reopen"}');
    await sink.reopen();
    sink.write('{"before":"close"}');
    await sink.close();

    const lines = (await readFile(join(directory, FILE_LOG_ACTIVE_NAME), 'utf8')).trim().split('\n');
    expect(lines).toEqual(['{"before":"reopen"}', '{"before":"close"}']);
  });

  it('previews and prunes rotated logs by age without touching unrelated entries', async () => {
    const directory = await makeTempDirectory();
    const sink = new RollingFileSink(options(directory, { retentionMs: 1_000 }));
    await sink.initialize();

    const expiredName = rotatedName(1);
    const expiredPath = join(directory, expiredName);
    const unrelatedPath = join(directory, 'application.jsonl');
    const disguisedDirectory = join(directory, rotatedName(2));
    const linkTarget = join(directory, 'link-target');
    const disguisedLink = join(directory, rotatedName(3));
    await writeFile(expiredPath, 'expired\n');
    await writeFile(unrelatedPath, 'unrelated\n');
    await mkdir(disguisedDirectory);
    await mkdir(linkTarget);
    await symlink(linkTarget, disguisedLink, process.platform === 'win32' ? 'junction' : 'dir');
    const now = new Date('2026-05-01T00:00:00.000Z');
    const old = new Date(now.getTime() - 2_000);
    await utimes(expiredPath, old, old);
    await utimes(unrelatedPath, old, old);

    const candidates = await sink.previewPrune(now);
    expect(candidates).toEqual([
      expect.objectContaining({ artifactId: expiredName, reason: 'age' }),
    ]);
    expect(await lstat(expiredPath)).toBeDefined();

    const result = await sink.prune(now);
    expect(result).toMatchObject({ scanned: 1, eligible: 1, deleted: 1, failed: 0 });
    expect(result.reclaimedBytes).toBe(Buffer.byteLength('expired\n'));
    await expect(lstat(expiredPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(unrelatedPath, 'utf8')).toBe('unrelated\n');
    expect((await lstat(disguisedDirectory)).isDirectory()).toBe(true);
    expect((await lstat(disguisedLink)).isSymbolicLink()).toBe(true);
    expect(await lstat(join(directory, FILE_LOG_ACTIVE_NAME))).toBeDefined();
    await sink.close();
  });

  it('prunes expired rotated logs during initialization', async () => {
    const directory = await makeTempDirectory();
    const expiredPath = join(directory, rotatedName(1));
    await writeFile(expiredPath, 'expired before startup\n');
    const old = new Date(Date.now() - 10_000);
    await utimes(expiredPath, old, old);
    const sink = new RollingFileSink(options(directory, { retentionMs: 1_000 }));

    await sink.initialize();

    await expect(lstat(expiredPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await lstat(join(directory, FILE_LOG_ACTIVE_NAME))).toBeDefined();
    await sink.close();
  });

  it('uses a collision counter without overwriting an existing rotated log', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const directory = await makeTempDirectory();
    const first = JSON.stringify({ message: 'a'.repeat(20) });
    const second = JSON.stringify({ message: 'b'.repeat(20) });
    const collision = `agentorchestrator.2026-01-01T00-00-00-000Z.${process.pid}.0.jsonl`;
    await writeFile(join(directory, collision), 'existing rotation\n');
    const sink = new RollingFileSink(options(directory, {
      maxFileSizeBytes: Buffer.byteLength(`${first}\n`, 'utf8') + 1,
      retentionMs: 365 * 24 * 60 * 60 * 1000,
    }));

    await sink.initialize();
    sink.write(first);
    sink.write(second);
    await sink.flush();

    expect(await readFile(join(directory, collision), 'utf8')).toBe('existing rotation\n');
    expect(await readFile(
      join(directory, `agentorchestrator.2026-01-01T00-00-00-000Z.${process.pid}.1.jsonl`),
      'utf8',
    )).toBe(`${first}\n`);
    await sink.close();
  });

  it('prunes the oldest survivors beyond the rotated-file count', async () => {
    const directory = await makeTempDirectory();
    const sink = new RollingFileSink(options(directory, {
      maxRotatedFiles: 1,
      retentionMs: 365 * 24 * 60 * 60 * 1000,
    }));
    await sink.initialize();

    const now = new Date('2026-05-01T00:00:00.000Z');
    const names = [rotatedName(1), rotatedName(2), rotatedName(3)];
    for (let index = 0; index < names.length; index++) {
      const path = join(directory, names[index]);
      await writeFile(path, `${index}`);
      const modified = new Date(now.getTime() - (names.length - index) * 1_000);
      await utimes(path, modified, modified);
    }

    const candidates = await sink.previewPrune(now);
    expect(candidates.map(candidate => candidate.artifactId)).toEqual(names.slice(0, 2));
    expect(candidates.every(candidate => candidate.reason === 'count')).toBe(true);

    const result = await sink.prune(now);
    expect(result).toMatchObject({ eligible: 2, deleted: 2, failed: 0 });
    expect((await readdir(directory)).filter(name => FILE_LOG_ROTATED_PATTERN.test(name))).toEqual([names[2]]);
    await sink.close();
  });

  it('rejects filesystem roots and symbolic-link destinations', async () => {
    expect(() => new RollingFileSink(options(parse(process.cwd()).root))).toThrow(/root/i);

    const parent = await makeTempDirectory();
    const real = join(parent, 'real');
    const linked = join(parent, 'linked');
    await mkdir(real);
    await symlink(real, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const sink = new RollingFileSink(options(linked));
    await expect(sink.initialize()).rejects.toThrow(/unsafe|real directory/i);
    await sink.close();
  });

  it('rejects a symbolic-link active file', async () => {
    const directory = await makeTempDirectory();
    const target = join(directory, 'target.jsonl');
    await writeFile(target, 'do not append\n');
    try {
      await symlink(target, join(directory, FILE_LOG_ACTIVE_NAME), 'file');
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    const sink = new RollingFileSink(options(directory));

    await expect(sink.initialize()).rejects.toThrow(/regular file/i);
    expect(await readFile(target, 'utf8')).toBe('do not append\n');
    await sink.close();
  });

  it('reports initialization failure and can recover through reopen', async () => {
    const directory = await makeTempDirectory();
    const activePath = join(directory, FILE_LOG_ACTIVE_NAME);
    await mkdir(activePath);
    const onFailure = vi.fn();
    const sink = new RollingFileSink(options(directory), onFailure);

    await expect(sink.initialize()).rejects.toThrow(/regular file/i);
    expect(onFailure).toHaveBeenCalledWith('initialize');

    await rm(activePath, { recursive: true });
    await sink.reopen();
    sink.write('{"recovered":true}');
    await sink.flush();
    expect((await readFile(activePath, 'utf8')).trim()).toBe('{"recovered":true}');
    await sink.close();
  });

  it('recovers through reopen after an asynchronous rotation failure', async () => {
    const directory = await makeTempDirectory();
    const activePath = join(directory, FILE_LOG_ACTIVE_NAME);
    const displacedPath = join(directory, 'displaced.jsonl');
    const first = JSON.stringify({ message: 'a'.repeat(20) });
    const second = JSON.stringify({ message: 'b'.repeat(20) });
    const onFailure = vi.fn();
    const sink = new RollingFileSink(options(directory, {
      maxFileSizeBytes: Buffer.byteLength(`${first}\n`, 'utf8') + 1,
    }), onFailure);

    await sink.initialize();
    sink.write(first);
    await sink.flush();
    await rename(activePath, displacedPath);
    await mkdir(activePath);

    sink.write(second);
    await expect(sink.flush()).rejects.toThrow(/not ready/i);
    expect(onFailure).toHaveBeenCalledWith('write');

    await rm(activePath, { recursive: true });
    await sink.reopen();
    sink.write('{"recovered":true}');
    await sink.flush();
    expect((await readFile(activePath, 'utf8')).trim()).toBe('{"recovered":true}');
    await sink.close();
  });

  it('validates numeric options', async () => {
    const directory = await makeTempDirectory();
    expect(() => new RollingFileSink(options(directory, { maxFileSizeBytes: 0 }))).toThrow(/maxFileSizeBytes/);
    expect(() => new RollingFileSink(options(directory, { maxRotatedFiles: -1 }))).toThrow(/maxRotatedFiles/);
    expect(() => new RollingFileSink(options(directory, { retentionMs: -1 }))).toThrow(/retentionMs/);
  });

  it('uses no-follow semantics where supported', () => {
    if (process.platform !== 'win32') expect(constants.O_NOFOLLOW).toBeGreaterThan(0);
  });
});
