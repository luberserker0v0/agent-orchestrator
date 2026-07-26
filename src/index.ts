import 'dotenv/config';
import { loadConfig, loadCanonicalConfig } from './config-loader.js';
import { WorkspaceFactory } from './orchestrator/workspace-factory.js';
import { LocalStorage } from './storage/index.js';
import type { StorageBackend } from './storage/types.js';
import { InstanceManager } from './orchestrator/instance-manager.js';
import { RuntimeManager } from './agent-runtime/runtime-manager.js';
import { ConversationState } from './orchestrator/conversation-state.js';
import { ConfigService } from './services/config-service.js';
import { AgentService } from './services/agent-service.js';
import { SkillService } from './services/skill-service.js';
import { ConversationService } from './services/conversation-service.js';
import { FileService } from './services/file-service.js';
import { SessionService } from './services/session-service.js';
import { MessageService } from './services/message-service.js';
import { RoleService } from './services/role-service.js';
import { RuntimeRegistry } from './agent-runtime/registry.js';
import { RuntimeFactory } from './agent-runtime/runtime-factory.js';
import { DirectRuntime } from './agent-runtime/runtimes/direct.js';
import { DockerRuntime } from './agent-runtime/runtimes/docker.js';
import { PortPool } from './orchestrator/port-pool.js';
import { SSEBridge } from './orchestrator/sse-bridge.js';
import { createHttpServer } from './http-api/server.js';
import { logger } from './utils/logger.js';
import { parseCliArgs, printHelp, handleSubcommand } from './cli.js';
import { isRunningInContainer } from './utils/is-container.js';

export async function main(cliArgs?: string[]) {
  const cli = parseCliArgs(cliArgs ?? process.argv.slice(2));

  if (cli.help) {
    printHelp();
    return;
  }

  if (cli.version) {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    console.log(`v${pkg.version}`);
    return;
  }

  if (await handleSubcommand(cli)) return;

  // Set env vars from CLI args so applyEnvOverrides picks them up
  if (cli.port !== undefined) process.env['AGENTORCHESTRATOR_SERVER_PORT'] = String(cli.port);
  if (cli.host !== undefined) process.env['AGENTORCHESTRATOR_SERVER_HOST'] = cli.host;

  logger.info('AgentOrchestrator starting...');

  const config = loadConfig(cli.configPath);

  // Validate container + runtime + storage compatibility
  if (isRunningInContainer()) {
    const defaultEntry = config.orchestrator.runtimes.find(
      r => r.id === config.orchestrator.defaultAgentType
    );
    if (defaultEntry && defaultEntry.type !== 'direct' && config.workspace.storage.type === 'local') {
      throw new Error(
        'AO is running inside a container with default runtime type "' + defaultEntry.type + '" ' +
        'but workspace.storage is "local". Container-based agent instances cannot access ' +
        'the AO container\'s local filesystem. Set workspace.storage to a non-local type ' +
        '(e.g., "docker-volume") that supports volume sharing between containers.'
      );
    }
    if (defaultEntry?.type === 'docker' && !defaultEntry.config.instanceHost) {
      logger.warn(
        'AO is running inside a container with Docker runtime. The default instanceHost "127.0.0.1" ' +
        'may not reach OpenCode containers. Set instanceHost to "host.docker.internal" or use ' +
        'networkMode "host" in your runtime config if SSE events are not received.'
      );
    }
  }
  const canonicalConfig = loadCanonicalConfig(config.workspace.enforceCanonicalConfig);
  logger.info('Configuration loaded');

  let storage: StorageBackend;
  if (config.workspace.storage.type === 'local') {
    storage = new LocalStorage(config.workspace.basePath);
  } else {
    throw new Error(`Unsupported storage type: ${(config.workspace.storage as { type: string }).type}`);
  }

  const workspaceFactory = new WorkspaceFactory(config.workspace, storage, canonicalConfig);

  // Set up runtime registry — register all runtimes from config
  const runtimeFactory = new RuntimeFactory();
  runtimeFactory.register('direct', DirectRuntime);
  runtimeFactory.register('docker', DockerRuntime, (config) => {
    const errs: string[] = [];
    const cfg = config as Record<string, unknown>;
    if (!cfg?.image || typeof cfg.image !== 'string') errs.push('"image" is required');
    if (cfg?.networkMode !== undefined && typeof cfg.networkMode !== 'string')
      errs.push('"networkMode" must be a string');
    return errs;
  });

  const runtimeRegistry = new RuntimeRegistry();
  const portPool = new PortPool(config.orchestrator.portRange.start, config.orchestrator.portRange.end, config.orchestrator.portRange.allowDynamicFallback);
  for (const entry of config.orchestrator.runtimes) {
    const configErrors = runtimeFactory.validateConfig(entry.type, entry.config);
    if (configErrors.length > 0) {
      const msg = `Config validation failed: ${configErrors.join('; ')}`;
      logger.warn(`Runtime "${entry.id}" (type: ${entry.type}) is invalid: ${msg}`);
      runtimeRegistry.registerInvalid(entry.id, msg);
      continue;
    }
    if (!runtimeFactory.hasType(entry.type)) {
      const msg = `Unknown runtime type: "${entry.type}"`;
      logger.warn(`Runtime "${entry.id}" is invalid: ${msg}`);
      runtimeRegistry.registerInvalid(entry.id, msg);
      continue;
    }
    try {
      const runtime = runtimeFactory.create(entry.type, portPool, entry.config);
      runtimeRegistry.register(entry.id, runtime);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Runtime "${entry.id}" (type: ${entry.type}) is invalid: ${msg}`);
      runtimeRegistry.registerInvalid(entry.id, msg);
    }
  }
  logger.info(`Agent runtimes registered: ${runtimeRegistry.list().join(', ')}`);

  const runtimeManager = new RuntimeManager(portPool, runtimeRegistry, config.orchestrator.defaultAgentType);
  const conversationState = new ConversationState();
  const sseBridge = new SSEBridge(conversationState, config.orchestrator.sse);
  runtimeManager.setOnDestroyed((id: string) => {
    const state = conversationState.get(id);
    if (!state) return;
    if (state.status === 'stopped' || state.status === 'destroyed' || state.status === 'restarting') return;
    sseBridge.stop(id);
    conversationState.cancelReadyCheck(id);
    conversationState.transition(id, 'stopped');
    conversationState.removeRunningInstance(id);
  });
  const instanceManager = new InstanceManager(config.orchestrator, workspaceFactory, runtimeManager);
  const configService = new ConfigService(workspaceFactory, conversationState);
  const agentService = new AgentService(workspaceFactory, conversationState, instanceManager);
  const skillService = new SkillService(workspaceFactory, conversationState);
  const conversationService = new ConversationService(instanceManager, conversationState, workspaceFactory, runtimeManager, config.server, config.orchestrator.defaultAgentType, sseBridge);
  const fileService = new FileService(workspaceFactory, conversationState);
  const sessionService = new SessionService(instanceManager, conversationState);
  const messageService = new MessageService(instanceManager, conversationState);
  const roleService = new RoleService(cli.configPath ?? 'config/agentorchestrator.json', config.roles);

  // Clean up orphan resources from previous runs (e.g., after SIGKILL/crash)
  await instanceManager.cleanupOrphanContainers();
  await workspaceFactory.cleanupOrphans();

  const httpServer = createHttpServer(config.server, config.websocket, instanceManager, workspaceFactory, conversationState, configService, agentService, skillService, runtimeRegistry, conversationService, fileService, sessionService, messageService, roleService, config);

  httpServer.server.listen(config.server.port, config.server.host, () => {
    const addr = httpServer.server.address();
    if (addr && typeof addr === 'object') {
      config.server.port = addr.port;
    }
    logger.info(`AgentOrchestrator listening on http://${config.server.host}:${config.server.port}`);
    logger.info(`WebSocket endpoint: ws://${config.server.host}:${config.server.port}/ws/{conversationId}`);
    logger.info(`Dashboard: http://${config.server.host}:${config.server.port}/dashboard`);
    logger.info(`Max instances: ${config.orchestrator.maxInstances}`);
    logger.info(`Port range: ${config.orchestrator.portRange.start}-${config.orchestrator.portRange.end}`);

    // Compute RBAC status for startup info
    const resolvedKeys = config.server.apiKeys ?? (config.server.apiKey ? [{ key: config.server.apiKey, role: 'admin' as const, name: 'legacy' }] : []);
    const rbacEnabled = config.server.rbac?.enabled === true
      ? true
      : config.server.rbac?.enabled === false
        ? false
        : resolvedKeys.length > 0;
    const rbacStatus = rbacEnabled
      ? resolvedKeys.length > 0 ? `${resolvedKeys.length} key(s)` : 'enabled (0 keys)'
      : 'disabled';
    const wsType = config.workspace.storage.type;
    const maxSize = config.workspace.maxSizeBytes === 0 || config.workspace.maxSizeBytes === undefined
      ? 'unlimited'
      : `${config.workspace.maxSizeBytes} bytes`;
    logger.info(`RBAC: ${rbacStatus} | Workspace: ${wsType}, ${maxSize}`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);

    // Hard timeout for the entire shutdown sequence
    const hardTimeout = setTimeout(() => {
      logger.error(`Shutdown timeout exceeded (${config.server.shutdownTimeoutMs}ms), forcing exit`);
      process.exit(1);
    }, config.server.shutdownTimeoutMs);

    try {
      // Stop idle sweep timer to prevent interference during shutdown
      instanceManager.destroy();

      // Stop accepting new WebSocket connections and close existing ones cleanly
      httpServer.closeWebSockets();
      logger.info('WebSocket connections closed');

      // Stop accepting new HTTP connections
      httpServer.server.close(() => {
        logger.info('HTTP server closed');
      });

      // Wait for in-flight HTTP requests to finish
      await httpServer.waitForRequests(config.server.shutdownTimeoutMs);

      // Destroy all active OpenCode instances
      const instances = instanceManager.listInstances();
      if (instances.length > 0) {
        logger.info(`Destroying ${instances.length} active instance(s)...`);
        await Promise.all(instances.map((inst) => instanceManager.destroyInstance(inst.id).catch(() => {})));
      }

      logger.info('Shutdown complete');
      clearTimeout(hardTimeout);
      process.exit(0);
    } catch (err) {
      logger.error('Error during shutdown:', err);
      clearTimeout(hardTimeout);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Unhandled errors
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception:', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection:', reason);
  });
}

// Allow running as a script
const isMain = process.argv.length > 1 && process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index.ts');
if (isMain) {
  main().catch((err) => {
    logger.error('Fatal error during startup:', err);
    process.exit(1);
  });
}
