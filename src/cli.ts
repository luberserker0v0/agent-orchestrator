import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface CliOptions {
  port?: number;
  host?: string;
  configPath?: string;
  help?: boolean;
  version?: boolean;
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

Options:
  -p, --port <number>    HTTP server port (default: auto-assigned)
  -H, --host <string>    Bind address (default: 127.0.0.1)
  -c, --config <path>    Path to config JSON file
  -h, --help             Show this help message
  -v, --version          Show version number
`);
}
