import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import { registerK8sCommands } from './cli/k8s-command.js';
import { CliActionError, registerOperationalCommands } from './cli/operational.js';

export interface ServerCliOptions {
  port?: number;
  host?: string;
  configPath?: string;
}

export interface OperatorCliOptions {
  namespace: string;
  intervalMs: number;
  execute: boolean;
  apiKey?: string;
  migrateTimeoutMs: number;
  refillWindowMs: number;
  modelRefillWindows: Record<string, number>;
  metricsPort: number;
  pvcStorage: string;
}

export type CliExecution =
  | { mode: 'serve'; options: ServerCliOptions }
  | { mode: 'handled' };

export interface CliDependencies {
  runOperator(options: OperatorCliOptions, configPath?: string): Promise<void>;
}

export async function executeCli(
  argv: string[] = process.argv.slice(2),
  dependencies?: Partial<CliDependencies>,
): Promise<CliExecution> {
  const version = readVersion();
  let execution: CliExecution = { mode: 'handled' };
  const program = new Command();
  program
    .name('aor')
    .description('AgentOrchestrator operational and Kubernetes management CLI')
    .version(version, '-v, --version', 'Show version number')
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: value => process.stdout.write(value),
      writeErr: value => process.stderr.write(value),
    })
    .option('-p, --port <number>', 'HTTP server port')
    .option('-H, --host <host>', 'HTTP server bind address')
    .option('-c, --config <path>', 'Path to AgentOrchestrator configuration')
    .option('--server <url>', 'AgentOrchestrator API URL', process.env['AOR_SERVER_URL'] ?? 'http://127.0.0.1:8080')
    .option('--api-key-file <path>', 'Read the API key from a file')
    .option('--timeout <ms>', 'API request timeout', '30000')
    .option('--json', 'Emit machine-readable JSON')
    .action(options => {
      execution = { mode: 'serve', options: serverOptions(options) };
    });

  program.command('serve')
    .description('Start the AgentOrchestrator server')
    .option('-p, --port <number>', 'HTTP server port')
    .option('-H, --host <host>', 'HTTP server bind address')
    .option('-c, --config <path>', 'Path to AgentOrchestrator configuration')
    .action((options, command) => {
      execution = { mode: 'serve', options: serverOptions({ ...command.optsWithGlobals(), ...options }) };
    });

  registerOperationalCommands(program);
  registerK8sCommands(program, version);
  registerOperatorCommand(program, dependencies);

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') return { mode: 'handled' };
      process.exitCode = 2;
      return { mode: 'handled' };
    }
    if (error instanceof CliActionError) {
      process.stderr.write(`Error: ${error.message}\n`);
      process.exitCode = error.exitCode;
      return { mode: 'handled' };
    }
    const message = error instanceof Error ? error.message : 'Unknown CLI error';
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
    return { mode: 'handled' };
  }
  return execution;
}

function registerOperatorCommand(program: Command, dependencies?: Partial<CliDependencies>): void {
  program.command('operator')
    .description('Run the quota-aware Kubernetes placement controller')
    .option('--namespace <namespace>', 'Kubernetes namespace', 'ao-instances')
    .option('--interval-ms <ms>', 'Reconcile interval', '15000')
    .option('--execute', 'Execute planned migrations')
    .option('--api-key <key>', 'Bearer token for migration callbacks')
    .option('--migrate-timeout-ms <ms>', 'Migration callback timeout', '300000')
    .option('--refill-window-ms <ms>', 'Default quota refill window', String(24 * 60 * 60 * 1000))
    .option('--model-refill-window <provider/model=ms>', 'Per-model refill window; repeatable', collect, [])
    .option('--metrics-port <port>', 'Prometheus metrics port (0 disables)', '0')
    .option('--pvc-storage <size>', 'Per-conversation PVC size', '10Gi')
    .action(async (options, command) => {
      if (!dependencies?.runOperator) throw new CliActionError('Operator runner is unavailable');
      const modelRefillWindows: Record<string, number> = {};
      for (const entry of options.modelRefillWindow as string[]) {
        const separator = entry.lastIndexOf('=');
        const model = entry.slice(0, separator);
        const duration = positiveInteger(entry.slice(separator + 1), '--model-refill-window');
        if (separator < 1 || !model.includes('/')) throw new CliActionError(`Invalid model refill window: ${entry}`, 2);
        modelRefillWindows[model] = duration;
      }
      await dependencies.runOperator({
        namespace: options.namespace,
        intervalMs: positiveInteger(options.intervalMs, '--interval-ms'),
        execute: options.execute === true,
        apiKey: options.apiKey ?? process.env['AOR_OPERATOR_API_KEY'],
        migrateTimeoutMs: positiveInteger(options.migrateTimeoutMs, '--migrate-timeout-ms'),
        refillWindowMs: positiveInteger(options.refillWindowMs, '--refill-window-ms'),
        modelRefillWindows,
        metricsPort: nonNegativeInteger(options.metricsPort, '--metrics-port'),
        pvcStorage: options.pvcStorage,
      }, (command.optsWithGlobals() as { config?: string }).config);
    });
}

function serverOptions(options: { port?: string; host?: string; config?: string }): ServerCliOptions {
  return {
    ...(options.port !== undefined ? { port: portNumber(options.port) } : {}),
    ...(options.host ? { host: options.host } : {}),
    ...(options.config ? { configPath: options.config } : {}),
  };
}

function portNumber(value: string): number {
  const port = nonNegativeInteger(value, '--port');
  if (port > 65535) throw new CliActionError('Port must be between 0 and 65535', 2);
  return port;
}

function positiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new CliActionError(`${option} must be a positive integer`, 2);
  return parsed;
}

function nonNegativeInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new CliActionError(`${option} must be a non-negative integer`, 2);
  return parsed;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '1.0.0';
  } catch {
    return '1.0.0';
  }
}
