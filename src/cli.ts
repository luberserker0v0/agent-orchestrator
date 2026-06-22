import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentOrchestratorConfig } from './config-loader.js';

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
  runtime list           List configured runtimes
  runtime info <id>      Show runtime info for a specific id
`);
}

export function handleSubcommand(cli: CliOptions): boolean {
  if (!cli.subcommand) return false;

  const args = cli.subcommandArgs ?? [];

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
