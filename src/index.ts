import dotenv from 'dotenv';
import type { AgentOrchestratorConfig } from './config-loader.js';
import { loadConfig } from './config-loader.js';
import type { K8sStatusReporter } from './cluster/status-reporter.js';
import type { InstanceManager } from './orchestrator/instance-manager.js';
import type { CleanupManager } from './cleanup/cleanup-manager.js';
import { executeCli, type OperatorCliOptions } from './cli.js';
import { createHttpServer, type HttpServer } from './http-api/server.js';
import { logFileErrorsTotal } from './metrics/registry.js';
import { configureFileLogging, logger, pruneFileLogs, shutdownLogger } from './utils/logger.js';
import {
  createApplicationServices,
  createStorage,
  validateContainerDeployment,
} from './bootstrap/application-services.js';
import { createCleanupManager } from './bootstrap/cleanup.js';
import { createRuntimeEnvironment } from './bootstrap/runtime-environment.js';

export { validateContainerRuntimeStorage } from './bootstrap/application-services.js';

const FATAL_LOGGER_SHUTDOWN_TIMEOUT_MS = 1_000;

dotenv.config({ quiet: true });

/** Configure the optional process-wide JSONL sink before operational logs. */
export async function initializeConfiguredFileLogging(
  config: Pick<AgentOrchestratorConfig, 'logging'>,
): Promise<void> {
  if (!config.logging.file.enabled) return;
  await configureFileLogging(config.logging.file, operation => {
    logFileErrorsTotal.labels(operation).inc();
  });
}

async function runOperatorCli(options: OperatorCliOptions, configPath?: string): Promise<void> {
  const config = loadConfig(configPath);
  await initializeConfiguredFileLogging(config);
  const { runOperator } = await import('./cluster/operator/controller.js');
  const stop = await runOperator({
    namespace: options.namespace,
    intervalMs: options.intervalMs,
    execute: options.execute,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    migrateTimeoutMs: options.migrateTimeoutMs,
    refill: { defaultWindowMs: options.refillWindowMs, perModel: options.modelRefillWindows },
    ...(options.metricsPort > 0 ? { metricsPort: options.metricsPort } : {}),
    pvcStorage: options.pvcStorage,
    ...(config.cleanup.ownerId ? { cleanupOwnerId: config.cleanup.ownerId } : {}),
  });
  installOperatorShutdown(config, stop);
  logger.info(
    `Placement controller running (namespace: ${options.namespace}, interval: ${options.intervalMs}ms, ` +
    `${options.execute ? 'execute' : 'dry-run'})`,
  );
}

function installOperatorShutdown(config: AgentOrchestratorConfig, stop: () => void): void {
  const logPruneTimer = config.logging.file.enabled
    ? setInterval(() => {
        void pruneFileLogs().catch(() => logger.warn('Scheduled operator file-log pruning failed'));
      }, config.cleanup.sweepIntervalMs)
    : undefined;
  logPruneTimer?.unref?.();
  const keepAlive = setInterval(() => {}, 60_000);
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(keepAlive);
    if (logPruneTimer) clearInterval(logPruneTimer);
    stop();
    void shutdownLogger(config.server.shutdownTimeoutMs).finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export async function main(cliArgs?: string[]): Promise<void> {
  const execution = await executeCli(cliArgs ?? process.argv.slice(2), { runOperator: runOperatorCli });
  if (execution.mode === 'handled') return;
  const cli = execution.options;
  if (cli.port !== undefined) process.env['AGENTORCHESTRATOR_SERVER_PORT'] = String(cli.port);
  if (cli.host !== undefined) process.env['AGENTORCHESTRATOR_SERVER_HOST'] = cli.host;

  const config = loadConfig(cli.configPath);
  await initializeConfiguredFileLogging(config);
  logger.info('AgentOrchestrator starting...');
  validateContainerDeployment(config);

  const storage = createStorage(config);
  const runtimes = createRuntimeEnvironment(config);
  const services = await createApplicationServices(config, cli.configPath, storage, runtimes);
  const cleanup = createCleanupManager(config, storage, runtimes, services);
  await services.instanceManager.cleanupOrphanContainers();
  await services.workspaceFactory.cleanupOrphans();
  cleanup.start();

  const http = createHttpServer(
    config.server,
    config.websocket,
    services.instanceManager,
    services.workspaceFactory,
    services.conversationState,
    services.configService,
    services.agentService,
    services.skillService,
    runtimes.registry,
    services.conversationService,
    services.fileService,
    services.sessionService,
    services.messageService,
    services.roleService,
    config,
    cleanup,
  );
  listen(http, config, services.statusReporter);
  installProcessHandlers(config, http, services.instanceManager, cleanup, services.statusReporter);
}

function listen(http: HttpServer, config: AgentOrchestratorConfig, reporter: K8sStatusReporter): void {
  http.server.listen(config.server.port, config.server.host, () => {
    const address = http.server.address();
    if (address && typeof address === 'object') config.server.port = address.port;
    if (!config.cluster?.advertiseBaseUrl) {
      reporter.setAdvertiseBaseUrl(`http://${config.server.host}:${config.server.port}`);
    }
    logger.info(`AgentOrchestrator listening on http://${config.server.host}:${config.server.port}`);
    logger.info(`WebSocket endpoint: ws://${config.server.host}:${config.server.port}/ws/{conversationId}`);
    logger.info(`Dashboard: http://${config.server.host}:${config.server.port}/dashboard`);
    logger.info(`Max instances: ${config.orchestrator.maxInstances}`);
    logger.info(`Port range: ${config.orchestrator.portRange.start}-${config.orchestrator.portRange.end}`);
    logger.info(startupSecuritySummary(config));
  });
}

function startupSecuritySummary(config: AgentOrchestratorConfig): string {
  const keys = config.server.apiKeys ?? (config.server.apiKey ? [{ key: config.server.apiKey }] : []);
  const enabled = config.server.rbac?.enabled ?? keys.length > 0;
  const rbac = enabled ? keys.length > 0 ? `${keys.length} key(s)` : 'enabled (0 keys)' : 'disabled';
  const maximum = config.workspace.maxSizeBytes === 0 || config.workspace.maxSizeBytes === undefined
    ? 'unlimited'
    : `${config.workspace.maxSizeBytes} bytes`;
  return `RBAC: ${rbac} | Workspace: ${config.workspace.storage.type}, ${maximum}`;
}

function installProcessHandlers(
  config: AgentOrchestratorConfig,
  http: HttpServer,
  instances: InstanceManager,
  cleanup: CleanupManager,
  reporter: K8sStatusReporter,
): void {
  let started = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (started) return;
    started = true;
    await shutdownServer(signal, config, http, instances, cleanup, reporter);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('uncaughtException', error => {
    logger.error('Uncaught exception:', error);
    void shutdownLogger(FATAL_LOGGER_SHUTDOWN_TIMEOUT_MS).finally(() => process.exit(1));
  });
  process.on('unhandledRejection', reason => logger.error('Unhandled rejection:', reason));
}

async function shutdownServer(
  signal: string,
  config: AgentOrchestratorConfig,
  http: HttpServer,
  instances: InstanceManager,
  cleanup: CleanupManager,
  reporter: K8sStatusReporter,
): Promise<void> {
  const deadline = Date.now() + config.server.shutdownTimeoutMs;
  logger.info(`Received ${signal}, shutting down...`);
  const hardTimeout = setTimeout(() => {
    logger.error(`Shutdown timeout exceeded (${config.server.shutdownTimeoutMs}ms), forcing exit`);
    process.exit(1);
  }, config.server.shutdownTimeoutMs);
  try {
    instances.destroy();
    await cleanup.shutdown();
    reporter.destroy();
    http.closeWebSockets();
    logger.info('WebSocket connections closed');
    http.server.close(() => logger.info('HTTP server closed'));
    await http.waitForRequests(config.server.shutdownTimeoutMs);
    const active = instances.listInstances();
    if (active.length > 0) {
      logger.info(`Destroying ${active.length} active instance(s)...`);
      await Promise.all(active.map(instance => instances.destroyInstance(instance.id).catch(() => {})));
    }
    logger.info('Shutdown complete');
    await shutdownLogger(Math.max(0, deadline - Date.now()));
    clearTimeout(hardTimeout);
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown:', error);
    await shutdownLogger(Math.max(0, deadline - Date.now()));
    clearTimeout(hardTimeout);
    process.exit(1);
  }
}

const isMain = process.argv.length > 1
  && (process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index.ts'));
if (isMain) {
  main().catch(async error => {
    logger.error('Fatal error during startup:', error);
    await shutdownLogger(FATAL_LOGGER_SHUTDOWN_TIMEOUT_MS);
    process.exit(1);
  });
}
