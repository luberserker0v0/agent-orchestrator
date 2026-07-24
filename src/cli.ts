import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentOrchestratorConfig } from './config-loader.js';
import { exec } from 'node:child_process';
import { logger } from './utils/logger.js';

export interface CliOptions {
  port?: number;
  host?: string;
  configPath?: string;
  help?: boolean;
  version?: boolean;
  subcommand?: string;
  subcommandArgs?: string[];
}

function readVersion(): string {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

export function parseCliArgs(argv: string[] = process.argv.slice(2)): CliOptions {
  const options: CliOptions = {};

  // Check for subcommand before parsing options
  if (argv.length > 0 && !argv[0].startsWith('-')) {
    options.subcommand = argv[0];
    options.subcommandArgs = argv.slice(1);
    return options;
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--version' || arg === '-v') {
      options.version = true;
    } else if ((arg === '--port' || arg === '-p') && i + 1 < argv.length) {
      options.port = Number(argv[++i]);
    } else if ((arg === '--host' || arg === '-H') && i + 1 < argv.length) {
      options.host = argv[++i];
    } else if ((arg === '--config' || arg === '-c') && i + 1 < argv.length) {
      options.configPath = argv[++i];
    } else if (!arg.startsWith('-')) {
      // Found a non-flag argument after options - treat as subcommand
      options.subcommand = arg;
      options.subcommandArgs = argv.slice(i + 1);
      break;
    }
  }

  return options;
}

export function printHelp(): void {
  const version = readVersion();
  console.log(`
aor v${version} - AgentOrchestrator

Usage: aor [options]
       aor <subcommand> [args]

Options:
  -p, --port <number>    HTTP server port (default: auto-assigned)
  -H, --host <string>    Bind address (default: 127.0.0.1)
  -c, --config <path>    Path to config JSON file
  -h, --help             Show this help message
  -v, --version          Show version number

Subcommands:
  dashboard              Open dashboard in browser
  runtime list           List configured runtimes
  runtime info <id>      Show runtime info for a specific id
`);
}

export async function handleSubcommand(cli: CliOptions): Promise<boolean> {
  if (!cli.subcommand) return false;

  const args = cli.subcommandArgs ?? [];

  if (cli.subcommand === 'dashboard') {
    const port = cli.port ?? await getPortFromConfig(cli.configPath);
    const host = cli.host ?? '127.0.0.1';
    openDashboard(host, port);
    return true;
  }

  if (cli.subcommand === 'runtime') {
    if (args[0] === 'list') {
      (async () => {
        const { loadConfig } = await import('./config-loader.js');
        printRuntimeList(loadConfig);
      })();
      return true;
    }
    if (args[0] === 'info' && args[1]) {
      (async () => {
        const { loadConfig } = await import('./config-loader.js');
        printRuntimeInfo(args[1], loadConfig);
      })();
      return true;
    }
    console.error('Usage: aor runtime list|info <id>');
    return true;
  }

  console.error(`Unknown subcommand: ${cli.subcommand}`);
  return true;
}

function printRuntimeList(loadConfig: (configPath?: string) => AgentOrchestratorConfig): void {
  try {
    const config = loadConfig();
    const entries = config.orchestrator.runtimes;
    if (entries.length === 0) {
      console.log('No runtimes configured.');
      return;
    }
    console.log('Configured runtimes:');
    for (const entry of entries) {
      const version = entry.type === 'direct' ? (entry.config as any).version : (entry.config as any).image?.split(':')[1] ?? 'latest';
      console.log(`  ${entry.id}  (${entry.type}, v${version})`);
    }
  } catch (err) {
    console.error('Failed to load config:', (err as Error).message);
  }
}

function printRuntimeInfo(id: string, loadConfig: (configPath?: string) => AgentOrchestratorConfig): void {
  try {
    const config = loadConfig();
    const entry = config.orchestrator.runtimes.find((r: { id: string }) => r.id === id);
    if (!entry) {
      console.error(`Runtime "${id}" not found in config.`);
      return;
    }
    const version = entry.type === 'direct' ? (entry.config as any).version : (entry.config as any).image?.split(':')[1] ?? 'latest';
    console.log(`Runtime: ${entry.id}`);
    console.log(`  Type: ${entry.type}`);
    console.log(`  Version: ${version ?? 'unknown'}`);
    console.log(`  Config: ${JSON.stringify(entry.config, null, 4)}`);
  } catch (err) {
    console.error('Failed to load config:', (err as Error).message);
  }
}

async function getPortFromConfig(configPath?: string): Promise<number> {
  try {
    const { loadConfig } = await import('./config-loader.js');
    const config = loadConfig(configPath);
    return config.server.port ?? 8080;
  } catch {
    return 8080;
  }
}

function openDashboard(host: string, port: number): void {
  const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/dashboard`;
  const platform = process.platform;
  let cmd: string;
  if (platform === 'win32') {
    cmd = `start "" "${url}"`;
  } else if (platform === 'darwin') {
    cmd = `open "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  logger.info(`Opening dashboard: ${url}`);
  exec(cmd, (err) => {
    if (err) {
      logger.warn(`Failed to open browser: ${err.message}`);
      logger.info(`Dashboard URL: ${url}`);
    }
  });
}
