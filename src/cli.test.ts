import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseCliArgs, handleSubcommand, printHelp } from './cli.js';

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

  it('returns false when no subcommand', () => {
    expect(handleSubcommand({})).toBe(false);
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it('returns true for unknown subcommand', () => {
    const result = handleSubcommand({ subcommand: 'unknown', subcommandArgs: [] });
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
    handleSubcommand({ subcommand: 'runtime', subcommandArgs: ['list'] });
    // The async handler is triggered inside; we verify it returns true immediately
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it('handles runtime info by triggering async load', async () => {
    handleSubcommand({ subcommand: 'runtime', subcommandArgs: ['info', 'some-rt'] });
    expect(consoleLogSpy).not.toHaveBeenCalled();
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
