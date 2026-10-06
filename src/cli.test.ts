import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeCli } from './cli.js';

describe('executeCli', () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('preserves no-command server startup', async () => {
    await expect(executeCli([])).resolves.toEqual({ mode: 'serve', options: {} });
  });

  it('supports the explicit serve alias and options after the command', async () => {
    await expect(executeCli(['serve', '--port', '8080', '--host', '0.0.0.0', '--config', 'ao.json']))
      .resolves.toEqual({
        mode: 'serve',
        options: { port: 8080, host: '0.0.0.0', configPath: 'ao.json' },
      });
  });

  it('supports legacy server options without a subcommand', async () => {
    await expect(executeCli(['--port', '0', '--host', '127.0.0.1']))
      .resolves.toEqual({ mode: 'serve', options: { port: 0, host: '127.0.0.1' } });
  });

  it('uses usage exit code 2 for unknown options', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(executeCli(['--unknown'])).resolves.toEqual({ mode: 'handled' });
    expect(process.exitCode).toBe(2);
  });

  it('shows the nested command tree in help', async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(value => {
      output.push(String(value));
      return true;
    });
    await expect(executeCli(['--help'])).resolves.toEqual({ mode: 'handled' });
    const help = output.join('');
    expect(help).toContain('conversation');
    expect(help).toContain('cleanup');
    expect(help).toContain('k8s');
  });

  it('validates operator numeric options before starting', async () => {
    const runOperator = vi.fn();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await executeCli(['operator', '--interval-ms', '0'], { runOperator });
    expect(runOperator).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });
});
