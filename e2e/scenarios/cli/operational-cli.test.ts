import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type E2EServer } from '../../helpers/server.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const executable = join(repositoryRoot, 'bin', 'aor.js');

describe('operational aor CLI', () => {
  let server: E2EServer;

  beforeAll(async () => {
    server = await startServer();
  });

  afterAll(async () => {
    await server.cleanup();
  });

  async function aor(...args: string[]): Promise<unknown> {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      executable,
      '--server', server.baseUrl,
      '--json',
      ...args,
    ], {
      cwd: repositoryRoot,
      timeout: 30_000,
      env: { ...process.env, AOR_API_KEY: '' },
    });
    expect(stderr).toBe('');
    return JSON.parse(stdout) as unknown;
  }

  it('checks status and manages a workspace-only conversation', async () => {
    const status = await aor('status') as { health: { status: string } };
    expect(status.health.status).toBe('ok');

    const created = await aor('conversation', 'create', 'cli-e2e') as { id: string };
    expect(created.id).toBe('cli-e2e');

    const conversations = await aor('conversation', 'list') as Array<{ id: string }>;
    expect(conversations).toContainEqual(expect.objectContaining({ id: 'cli-e2e' }));

    expect(await aor('conversation', 'delete', 'cli-e2e', '--confirm')).toEqual({
      id: 'cli-e2e',
      deleted: true,
    });
  });
});
