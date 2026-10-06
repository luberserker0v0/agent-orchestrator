/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs';
import { exec } from 'node:child_process';
import { Command, Option } from 'commander';
import { loadConfig } from '../config-loader.js';
import { AoApiClient, apiExitCode, readApiKey } from './api-client.js';
import { printValue } from './output.js';

export class CliActionError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
    this.name = 'CliActionError';
  }
}

interface GlobalOptions {
  server: string;
  apiKeyFile?: string;
  timeout: string;
  json?: boolean;
  config?: string;
  host?: string;
  port?: string;
}

type AsyncAction = (...args: any[]) => Promise<void>;

export function registerOperationalCommands(program: Command): void {
  program.command('status')
    .description('Check server health and authenticated role')
    .action(wrap(async (_options, command) => {
      const { client, output, globals } = clientContext(command);
      const [health, auth] = await Promise.all([
        client.request('/health'),
        client.request('/api/auth/role'),
      ]);
      printValue({ server: globals.server, health, auth }, output);
    }));

  program.command('metrics')
    .description('Print Prometheus metrics')
    .action(wrap(async (_options, command) => {
      const { client, output } = clientContext(command);
      const metrics = await client.request<string>('/metrics', { accept: 'text/plain' });
      printValue(output.json ? { metrics } : metrics, output);
    }));

  registerConversationCommands(program);
  registerSessionCommands(program);
  registerMessageCommands(program);
  registerCleanupCommands(program);
  registerConfigCommands(program);
  registerRuntimeCommands(program);
  registerDashboardCommand(program);
}

function registerConversationCommands(program: Command): void {
  const conversation = program.command('conversation').description('Manage conversations');

  conversation.command('list').description('List conversations')
    .action(wrap(async (_options, command) => {
      const { client, output } = clientContext(command);
      printValue(await client.request('/api/conversations'), output);
    }));

  conversation.command('get').argument('<id>').description('Get conversation details')
    .action(wrap(async (id, _options, command) => {
      const { client, output } = clientContext(command);
      printValue(await client.request(`/api/conversations/${segment(id)}`), output);
    }));

  conversation.command('create')
    .argument('[id]')
    .option('--agent-type <runtime>')
    .option('--start', 'Start the conversation after creating it')
    .description('Create a conversation workspace')
    .action(wrap(async (id, options, command) => {
      const { client, output } = clientContext(command);
      const body = {
        ...(id ? { id } : {}),
        ...(options.agentType ? { agentType: options.agentType } : {}),
      };
      const created = await client.request<Record<string, unknown>>('/api/conversations', { method: 'POST', body });
      if (!options.start) {
        printValue(created, output);
        return;
      }
      const conversationId = typeof created.id === 'string' ? created.id : id;
      if (!conversationId) throw new CliActionError('Server did not return a conversation ID');
      const started = await client.request(`/api/conversations/${segment(conversationId)}/start`, { method: 'POST' });
      printValue({ conversation: created, start: started }, output);
    }));

  for (const operation of ['start', 'stop', 'restart'] as const) {
    conversation.command(operation).argument('<id>').description(`${capitalize(operation)} a conversation`)
      .action(wrap(async (id, _options, command) => {
        const { client, output } = clientContext(command);
        printValue(await client.request(`/api/conversations/${segment(id)}/${operation}`, { method: 'POST' }), output);
      }));
  }

  conversation.command('events').argument('<id>')
    .option('--limit <number>', 'Number of events (1-100)', parseIntegerInRange(1, 100), 50)
    .description('Show recent conversation events')
    .action(wrap(async (id, options, command) => {
      const { client, output } = clientContext(command);
      printValue(await client.request(`/api/conversations/${segment(id)}/events?limit=${options.limit}`), output);
    }));

  conversation.command('migrate').argument('<id>')
    .requiredOption('--node <name>', 'Target Kubernetes node')
    .description('Migrate a conversation to another node')
    .action(wrap(async (id, options, command) => {
      const { client, output } = clientContext(command);
      printValue(await client.request(`/api/conversations/${segment(id)}/migrate`, {
        method: 'POST', body: { nodeName: options.node },
      }), output);
    }));

  conversation.command('delete').argument('<id>')
    .requiredOption('--confirm', 'Confirm permanent workspace and managed-session deletion')
    .description('Delete a conversation and its managed persistent data')
    .action(wrap(async (id, _options, command) => {
      const { client, output } = clientContext(command);
      await client.request(`/api/conversations/${segment(id)}`, { method: 'DELETE' });
      printValue({ id, deleted: true }, output);
    }));
}

function registerSessionCommands(program: Command): void {
  const session = program.command('session').description('Manage OpenCode sessions');

  session.command('list').argument('<conversation>').action(wrap(async (conversation, _options, command) => {
    const { client, output } = clientContext(command);
    printValue(await client.request(`/api/conversations/${segment(conversation)}/sessions`), output);
  }));

  session.command('get').argument('<conversation>').argument('<session>').action(wrap(async (conversation, sessionId, _options, command) => {
    const { client, output } = clientContext(command);
    printValue(await client.request(`/api/conversations/${segment(conversation)}/sessions/${segment(sessionId)}`), output);
  }));

  session.command('create').argument('<conversation>')
    .option('--title <title>')
    .option('--parent <session>')
    .action(wrap(async (conversation, options, command) => {
      const { client, output } = clientContext(command);
      printValue(await client.request(`/api/conversations/${segment(conversation)}/sessions`, {
        method: 'POST',
        body: { ...(options.title ? { title: options.title } : {}), ...(options.parent ? { parentID: options.parent } : {}) },
      }), output);
    }));

  session.command('fork').argument('<conversation>').argument('<session>')
    .option('--message <message-id>')
    .action(wrap(async (conversation, sessionId, options, command) => {
      const { client, output } = clientContext(command);
      printValue(await client.request(`/api/conversations/${segment(conversation)}/sessions/${segment(sessionId)}/fork`, {
        method: 'POST', body: { ...(options.message ? { messageID: options.message } : {}) },
      }), output);
    }));

  session.command('messages').argument('<conversation>').argument('<session>')
    .option('--limit <number>', 'Maximum messages', positiveInteger)
    .action(wrap(async (conversation, sessionId, options, command) => {
      const { client, output } = clientContext(command);
      const query = options.limit ? `?limit=${options.limit}` : '';
      printValue(await client.request(`/api/conversations/${segment(conversation)}/sessions/${segment(sessionId)}/messages${query}`), output);
    }));

  session.command('abort').argument('<conversation>').action(wrap(async (conversation, _options, command) => {
    const { client, output } = clientContext(command);
    printValue(await client.request(`/api/conversations/${segment(conversation)}/sessions/abort`, { method: 'POST' }), output);
  }));

  session.command('delete').argument('<conversation>').argument('<session>')
    .requiredOption('--confirm', 'Confirm session deletion')
    .action(wrap(async (conversation, sessionId, _options, command) => {
      const { client, output } = clientContext(command);
      await client.request(`/api/conversations/${segment(conversation)}/sessions/${segment(sessionId)}`, { method: 'DELETE' });
      printValue({ conversation, session: sessionId, deleted: true }, output);
    }));
}

function registerMessageCommands(program: Command): void {
  const message = program.command('message').description('Send conversation messages');
  message.command('send').argument('<conversation>')
    .addOption(new Option('--text <text>').conflicts('file'))
    .addOption(new Option('--file <path>').conflicts('text'))
    .option('--model <provider/model>')
    .option('--agent <name>')
    .action(wrap(async (conversation, options, command) => {
      if (!options.text && !options.file) throw new CliActionError('One of --text or --file is required', 2);
      const text = options.file ? readFileSync(options.file, 'utf8') : options.text;
      if (!text) throw new CliActionError('Message text must not be empty', 2);
      const { client, output } = clientContext(command);
      printValue(await client.request(`/api/conversations/${segment(conversation)}/message`, {
        method: 'POST',
        body: { text, ...(options.model ? { model: options.model } : {}), ...(options.agent ? { agent: options.agent } : {}) },
      }), output);
    }));
}

function registerCleanupCommands(program: Command): void {
  const cleanup = program.command('cleanup').description('Preview or run configured cleanup policies');
  cleanup.command('preview')
    .option('--target <target>', 'logs or persistentData; repeatable', collect, [])
    .action(wrap(async (options, command) => {
      const targets = cleanupTargets(options.target, false);
      const { client, output } = clientContext(command);
      printValue(await client.request('/api/cleanup/preview', {
        method: 'POST', body: targets.length ? { targets } : {},
      }), output);
    }));

  cleanup.command('run')
    .requiredOption('--target <target>', 'logs or persistentData; repeatable', collect, [])
    .requiredOption('--confirm', 'Confirm cleanup execution')
    .action(wrap(async (options, command) => {
      const targets = cleanupTargets(options.target, true);
      const { client, output } = clientContext(command);
      const report = await client.request<Record<string, unknown>>('/api/cleanup/run', {
        method: 'POST', body: { targets, confirm: true },
      });
      printValue(report, output);
      if (report.status === 'partial' || report.status === 'failed') process.exitCode = 1;
    }));
}

function registerConfigCommands(program: Command): void {
  program.command('config').description('Validate local AgentOrchestrator configuration')
    .command('validate').argument('[file]')
    .action(wrap(async (file, _options, command) => {
      loadConfig(file);
      printValue({ valid: true, source: file ?? 'auto-discovered' }, { json: globalOptions(command).json === true });
    }));
}

function registerRuntimeCommands(program: Command): void {
  const runtime = program.command('runtime').description('Inspect locally configured runtimes');
  runtime.command('list').action(wrap(async (_options, command) => {
    const globals = globalOptions(command);
    const entries = loadConfig(globals.config).orchestrator.runtimes.map(entry => ({
      id: entry.id,
      type: entry.type,
      version: runtimeVersion(entry),
    }));
    printValue(entries, { json: globals.json === true });
  }));
  runtime.command('info').argument('<id>').action(wrap(async (id, _options, command) => {
    const globals = globalOptions(command);
    const entry = loadConfig(globals.config).orchestrator.runtimes.find(item => item.id === id);
    if (!entry) throw new CliActionError(`Runtime "${id}" not found in config.`, 4);
    printValue({ id: entry.id, type: entry.type, version: runtimeVersion(entry), config: redact(entry.config) }, { json: globals.json === true });
  }));
}

function registerDashboardCommand(program: Command): void {
  program.command('dashboard').description('Open the dashboard in a browser')
    .option('--server <url>', 'AgentOrchestrator base URL')
    .action(wrap(async (options, command) => {
      const globals = globalOptions(command);
      const legacyServer = globals.port
        ? `http://${globals.host === '0.0.0.0' ? 'localhost' : globals.host ?? '127.0.0.1'}:${globals.port}`
        : undefined;
      const raw = options.server ?? legacyServer ?? globals.server;
      const url = new URL('/dashboard', ensureHttpUrl(raw));
      const quoted = `"${url.toString()}"`;
      const shellCommand = process.platform === 'win32'
        ? `start "" ${quoted}`
        : process.platform === 'darwin' ? `open ${quoted}` : `xdg-open ${quoted}`;
      await new Promise<void>((resolve, reject) => exec(shellCommand, error => error ? reject(error) : resolve()));
      printValue({ opened: url.toString() }, { json: globals.json === true });
    }));
}

export function clientContext(command: Command): { client: AoApiClient; output: { json: boolean }; globals: GlobalOptions } {
  const globals = globalOptions(command);
  const timeoutMs = positiveInteger(globals.timeout);
  return {
    client: new AoApiClient({ server: globals.server, apiKey: readApiKey(globals.apiKeyFile), timeoutMs }),
    output: { json: globals.json === true },
    globals,
  };
}

function globalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals() as GlobalOptions;
}

function wrap(action: AsyncAction): (...args: any[]) => Promise<void> {
  return async (...args: any[]) => {
    try {
      await action(...args);
    } catch (error) {
      if (error instanceof CliActionError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new CliActionError(message, apiExitCode(error));
    }
  };
}

function segment(value: unknown): string {
  return encodeURIComponent(String(value));
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function cleanupTargets(values: string[], required: boolean): string[] {
  const unique = [...new Set(values)];
  if (required && unique.length === 0) throw new CliActionError('At least one --target is required', 2);
  for (const value of unique) {
    if (value !== 'logs' && value !== 'persistentData') {
      throw new CliActionError(`Invalid cleanup target: ${value}`, 2);
    }
  }
  return unique;
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new CliActionError(`Expected a positive integer, received: ${value}`, 2);
  return parsed;
}

function parseIntegerInRange(min: number, max: number): (value: string) => number {
  return value => {
    const parsed = positiveInteger(value);
    if (parsed < min || parsed > max) throw new CliActionError(`Expected an integer from ${min} to ${max}`, 2);
    return parsed;
  };
}

function ensureHttpUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new CliActionError('Server URL must use http or https', 2);
  return url;
}

function capitalize(value: string): string {
  return value[0].toUpperCase() + value.slice(1);
}

function runtimeVersion(entry: { type: string; config: object }): string {
  const config = entry.config as Record<string, unknown>;
  if (entry.type === 'direct') return typeof config.version === 'string' ? config.version : 'unknown';
  const image = typeof config.image === 'string' ? config.image : '';
  return image.includes(':') ? image.slice(image.lastIndexOf(':') + 1) : 'latest';
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    /(api.?key|token|password|secret|credential)/i.test(key) ? '[REDACTED]' : redact(item),
  ]));
}
