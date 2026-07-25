import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseCliArgs, handleSubcommand, printHelp } from './cli.js';
import { exec } from 'node:child_process';

vi.mock('node:child_process', () => ({
  exec: vi.fn((_cmd: string, cb: (err: Error | null) => void) => cb(null)),
}));

const mockedExec = vi.mocked(exec);

describe('parseCliArgs', () => {
  it('returns empty options for no args', () => {
    const result = parseCliArgs([]);
    expect(result).toEqual({});
  });

  it('parses --help', () => {
    const result = parseCliArgs(['--help']);
    expect(result.help).toBe(true);
  });

  it('parses -h', () => {
    const result = parseCliArgs(['-h']);
    expect(result.help).toBe(true);
  });

  it('parses --version', () => {
    const result = parseCliArgs(['--version']);
    expect(result.version).toBe(true);
  });

  it('parses -v', () => {
    const result = parseCliArgs(['-v']);
    expect(result.version).toBe(true);
  });

  it('parses --port', () => {
    const result = parseCliArgs(['--port', '8080']);
    expect(result.port).toBe(8080);
  });

  it('parses -p', () => {
    const result = parseCliArgs(['-p', '9090']);
    expect(result.port).toBe(9090);
  });

  it('parses --host', () => {
    const result = parseCliArgs(['--host', '0.0.0.0']);
    expect(result.host).toBe('0.0.0.0');
  });

  it('parses -H', () => {
    const result = parseCliArgs(['-H', '10.0.0.1']);
    expect(result.host).toBe('10.0.0.1');
  });

  it('parses --config', () => {
    const result = parseCliArgs(['--config', '/path/to/config.json']);
    expect(result.configPath).toBe('/path/to/config.json');
  });

  it('parses -c', () => {
    const result = parseCliArgs(['-c', './config.json']);
    expect(result.configPath).toBe('./config.json');
  });

  it('detects subcommand when first arg is not a flag', () => {
    const result = parseCliArgs(['runtime', 'list']);
    expect(result.subcommand).toBe('runtime');
    expect(result.subcommandArgs).toEqual(['list']);
  });

  it('detects subcommand with nested args', () => {
    const result = parseCliArgs(['runtime', 'info', 'my-rt']);
    expect(result.subcommand).toBe('runtime');
    expect(result.subcommandArgs).toEqual(['info', 'my-rt']);
  });

  it('treats single non-flag arg as subcommand', () => {
    const result = parseCliArgs(['help']);
    expect(result.subcommand).toBe('help');
    expect(result.subcommandArgs).toEqual([]);
  });

  it('handles multiple options together', () => {
    const result = parseCliArgs(['--port', '3000', '--host', '0.0.0.0', '--config', './my.json']);
    expect(result.port).toBe(3000);
    expect(result.host).toBe('0.0.0.0');
    expect(result.configPath).toBe('./my.json');
  });

  it('handles subcommand after options (non-flag after flags)', () => {
    const result = parseCliArgs(['--port', '3000', 'dashboard']);
    expect(result.port).toBe(3000);
    expect(result.subcommand).toBe('dashboard');
    expect(result.subcommandArgs).toEqual([]);
  });

  it('handles port at end of args (no value after flag)', () => {
    const result = parseCliArgs(['--port']);
    expect(result.port).toBeUndefined();
  });

  it('handles host at end of args (no value after flag)', () => {
    const result = parseCliArgs(['--host']);
    expect(result.host).toBeUndefined();
  });

  it('handles config at end of args (no value after flag)', () => {
    const result = parseCliArgs(['--config']);
    expect(result.configPath).toBeUndefined();
  });

  it('handles unknown flags gracefully', () => {
    const result = parseCliArgs(['--unknown']);
    expect(result).toEqual({});
  });
});

describe('handleSubcommand', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('returns false when no subcommand', async () => {
    expect(await handleSubcommand({})).toBe(false);
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it('returns true for unknown subcommand', async () => {
    const result = await handleSubcommand({ subcommand: 'unknown', subcommandArgs: [] });
    expect(result).toBe(true);
    expect(consoleErrorSpy).toHaveBeenCalledWith('Unknown subcommand: unknown');
  });

  it('prints usage for runtime without args', () => {
    handleSubcommand({ subcommand: 'runtime', subcommandArgs: [] });
    expect(consoleErrorSpy).toHaveBeenCalledWith('Usage: aor runtime list|info <id>');
  });

  it('prints usage for runtime with unknown sub-command', () => {
    handleSubcommand({ subcommand: 'runtime', subcommandArgs: ['invalid'] });
    expect(consoleErrorSpy).toHaveBeenCalledWith('Usage: aor runtime list|info <id>');
  });

  it('prints usage for runtime info without id', () => {
    handleSubcommand({ subcommand: 'runtime', subcommandArgs: ['info'] });
    expect(consoleErrorSpy).toHaveBeenCalledWith('Usage: aor runtime list|info <id>');
  });

  it('handles runtime list by triggering async load', async () => {
    const result = await handleSubcommand({ subcommand: 'runtime', subcommandArgs: ['list'] });
    expect(result).toBe(true);
  });

  it('handles runtime info by triggering async load', async () => {
    const result = await handleSubcommand({ subcommand: 'runtime', subcommandArgs: ['info', 'some-rt'] });
    expect(result).toBe(true);
  });
});

describe('printHelp', () => {
  it('outputs help text with subcommands', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printHelp();
    expect(spy).toHaveBeenCalled();
    const output = spy.mock.calls[0][0] as string;
    expect(output).toContain('Usage: aor [options]');
    expect(output).toContain('runtime list');
    expect(output).toContain('runtime info <id>');
    spy.mockRestore();
  });
});

describe('dashboard subcommand', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockedExec.mockReset();
    mockedExec.mockImplementation((_cmd: string, cb: (err: Error | null) => void) => cb(null));
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('opens dashboard with provided port', async () => {
    await handleSubcommand({ subcommand: 'dashboard', subcommandArgs: [], port: 5555 });
    await new Promise(r => setTimeout(r, 200));

    expect(mockedExec).toHaveBeenCalled();
    const cmd = mockedExec.mock.calls[mockedExec.mock.calls.length - 1][0] as string;
    expect(cmd).toContain('5555');
    expect(cmd).toContain('/dashboard');
  });

  it('opens dashboard with host 0.0.0.0 uses localhost', async () => {
    await handleSubcommand({ subcommand: 'dashboard', subcommandArgs: [], host: '0.0.0.0' });
    await new Promise(r => setTimeout(r, 200));

    expect(mockedExec).toHaveBeenCalled();
    const cmd = mockedExec.mock.calls[mockedExec.mock.calls.length - 1][0] as string;
    expect(cmd).toContain('localhost');
  });

  it('opens dashboard with custom host', async () => {
    await handleSubcommand({ subcommand: 'dashboard', subcommandArgs: [], host: '192.168.1.100' });
    await new Promise(r => setTimeout(r, 200));

    expect(mockedExec).toHaveBeenCalled();
    const cmd = mockedExec.mock.calls[mockedExec.mock.calls.length - 1][0] as string;
    expect(cmd).toContain('192.168.1.100');
  });

  it('opens dashboard with default host 127.0.0.1', async () => {
    await handleSubcommand({ subcommand: 'dashboard', subcommandArgs: [], port: 3000 });
    await new Promise(r => setTimeout(r, 200));

    expect(mockedExec).toHaveBeenCalled();
    const cmd = mockedExec.mock.calls[mockedExec.mock.calls.length - 1][0] as string;
    expect(cmd).toContain('127.0.0.1');
  });

  it('logs warning when exec fails', async () => {
    mockedExec.mockImplementation((_cmd: string, cb: (err: Error | null) => void) => {
      cb(new Error('Browser not found'));
      return {} as never;
    });

    await handleSubcommand({ subcommand: 'dashboard', subcommandArgs: [], port: 3000 });
    await new Promise(r => setTimeout(r, 200));

    expect(consoleLogSpy).toHaveBeenCalled();
  });
});

describe('runtime list output', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('prints runtime list with entries', async () => {
    await handleSubcommand({ subcommand: 'runtime', subcommandArgs: ['list'] });
    await new Promise(r => setTimeout(r, 200));

    const allOutput = consoleLogSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(allOutput).toContain('opencode-direct');
  });

  it('prints runtime info for existing runtime', async () => {
    await handleSubcommand({ subcommand: 'runtime', subcommandArgs: ['info', 'opencode-direct'] });
    await new Promise(r => setTimeout(r, 200));

    const allOutput = consoleLogSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(allOutput).toContain('Runtime: opencode-direct');
    expect(allOutput).toContain('Type: direct');
  });

  it('prints error for non-existing runtime', async () => {
    await handleSubcommand({ subcommand: 'runtime', subcommandArgs: ['info', 'nonexistent'] });
    await new Promise(r => setTimeout(r, 200));

    expect(consoleErrorSpy).toHaveBeenCalledWith('Runtime "nonexistent" not found in config.');
  });
});
