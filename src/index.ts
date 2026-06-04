import { loadConfig } from './config-loader.js';
import { WorkspaceFactory } from './orchestrator/workspace-factory.js';
import { InstanceManager } from './orchestrator/instance-manager.js';
import { createHttpServer } from './http-api/server.js';
import { logger } from './utils/logger.js';

async function main() {
  logger.info('AgentOrchestrator starting...');

  const config = loadConfig();
  logger.info('Configuration loaded');

  const workspaceFactory = new WorkspaceFactory(config.workspace);
  const instanceManager = new InstanceManager(config.orchestrator, workspaceFactory);

  const server = createHttpServer(config.server, config.websocket, instanceManager, config.orchestrator);

  server.listen(config.server.port, config.server.host, () => {
    const addr = server.address();
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

    // Stop idle sweep timer to prevent interference during shutdown
    instanceManager.destroy();

    // Destroy all active OpenCode instances
    const instances = instanceManager.listInstances();
    if (instances.length > 0) {
      logger.info(`Destroying ${instances.length} active instance(s)...`);
      await Promise.all(instances.map((inst) => instanceManager.destroyInstance(inst.id).catch(() => {})));
    }

    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });

    // Force exit if graceful shutdown takes too long
    setTimeout(() => {
      logger.error('Shutdown timeout exceeded, forcing exit');
      process.exit(1);
    }, 15000);
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

main().catch((err) => {
  logger.error('Fatal error during startup:', err);
  process.exit(1);
});
