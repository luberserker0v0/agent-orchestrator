import 'dotenv/config';
import { loadConfig, loadCanonicalConfig } from './config-loader.js';
import { WorkspaceFactory } from './orchestrator/workspace-factory.js';
import { InstanceManager } from './orchestrator/instance-manager.js';
import { ConversationState } from './orchestrator/conversation-state.js';
import { ConfigService } from './services/config-service.js';
import { AgentService } from './services/agent-service.js';
import { SkillService } from './services/skill-service.js';
import { ConversationService } from './services/conversation-service.js';
import { FileService } from './services/file-service.js';
import { SessionService } from './services/session-service.js';
import { MessageService } from './services/message-service.js';
import { RuntimeRegistry } from './agent-runtime/registry.js';
import { DirectRuntime } from './agent-runtime/runtimes/direct.js';
import { DockerRuntime } from './agent-runtime/runtimes/docker.js';
import { PortPool } from './orchestrator/port-pool.js';
import { createHttpServer } from './http-api/server.js';
import { logger } from './utils/logger.js';
import { parseCliArgs, printHelp } from './cli.js';

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

  // Set env vars from CLI args so applyEnvOverrides picks them up
  if (cli.port !== undefined) process.env['AGENTORCHESTRATOR_SERVER_PORT'] = String(cli.port);
  if (cli.host !== undefined) process.env['AGENTORCHESTRATOR_SERVER_HOST'] = cli.host;

  logger.info('AgentOrchestrator starting...');

  const config = loadConfig(cli.configPath);
  const canonicalConfig = loadCanonicalConfig(config.workspace.enforceCanonicalConfig);
  logger.info('Configuration loaded');

  const workspaceFactory = new WorkspaceFactory(config.workspace, canonicalConfig);

  // Set up runtime registry
  const runtimeRegistry = new RuntimeRegistry();
  const portPool = new PortPool(config.orchestrator.portRange.start, config.orchestrator.portRange.end, config.orchestrator.portRange.allowDynamicFallback);
  if (config.orchestrator.runtime === 'docker') {
    const dockerCfg = config.orchestrator.runtimeConfig.docker as { image: string; containerPort: number } | undefined;
    if (!dockerCfg) {
      throw new Error('Docker runtime selected but runtimeConfig.docker is missing');
    }
    const dockerRuntime = new DockerRuntime(portPool, dockerCfg.image, dockerCfg.containerPort);
    runtimeRegistry.register(dockerRuntime);
  } else {
    const binary = (config.orchestrator.runtimeConfig.binary as string) ?? 'opencode';
    const directRuntime = new DirectRuntime(portPool, binary);
    runtimeRegistry.register(directRuntime);
  }
  logger.info(`Agent runtimes registered: ${runtimeRegistry.list().join(', ')}`);

  const instanceManager = new InstanceManager(config.orchestrator, workspaceFactory, runtimeRegistry);
  const conversationState = new ConversationState();
  const configService = new ConfigService(workspaceFactory, conversationState);
  const agentService = new AgentService(workspaceFactory, conversationState, instanceManager);
  const skillService = new SkillService(workspaceFactory, conversationState);
  const conversationService = new ConversationService(instanceManager, conversationState, workspaceFactory, runtimeRegistry, config.server, config.orchestrator.runtime);
  const fileService = new FileService(workspaceFactory, conversationState);
  const sessionService = new SessionService(instanceManager, conversationState);
  const messageService = new MessageService(instanceManager, conversationState);

  // Clean up orphan resources from previous runs (e.g., after SIGKILL/crash)
  await instanceManager.cleanupOrphanContainers();
  workspaceFactory.cleanupOrphans();

  const httpServer = createHttpServer(config.server, config.websocket, instanceManager, workspaceFactory, conversationState, config.orchestrator, configService, agentService, skillService, runtimeRegistry, conversationService, fileService, sessionService, messageService);

  httpServer.server.listen(config.server.port, config.server.host, () => {
    const addr = httpServer.server.address();
    if (addr && typeof addr === 'object') {
      config.server.port = addr.port;
    }
    logger.info(`AgentOrchestrator listening on http://${config.server.host}:${config.server.port}`);
    logger.info(`WebSocket endpoint: ws://${config.server.host}:${config.server.port}/ws/{conversationId}`);
    logger.info(`Max instances: ${config.orchestrator.maxInstances}`);
    logger.info(`Port range: ${config.orchestrator.portRange.start}-${config.orchestrator.portRange.end}`);
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
