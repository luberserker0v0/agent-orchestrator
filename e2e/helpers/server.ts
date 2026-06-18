import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrchestratorConfig } from '../../src/config-loader.js';
import { createHttpServer, type HttpServer } from '../../src/http-api/server.js';
import { WorkspaceFactory } from '../../src/orchestrator/workspace-factory.js';
import { InstanceManager } from '../../src/orchestrator/instance-manager.js';
import { RuntimeManager } from '../../src/agent-runtime/runtime-manager.js';
import { ConversationState } from '../../src/orchestrator/conversation-state.js';
import { ConfigService } from '../../src/services/config-service.js';
import { AgentService } from '../../src/services/agent-service.js';
import { SkillService } from '../../src/services/skill-service.js';
import { ConversationService } from '../../src/services/conversation-service.js';
import { FileService } from '../../src/services/file-service.js';
import { SessionService } from '../../src/services/session-service.js';
import { MessageService } from '../../src/services/message-service.js';
import { RuntimeRegistry } from '../../src/agent-runtime/registry.js';
import { RuntimeFactory } from '../../src/agent-runtime/runtime-factory.js';
import { DirectRuntime } from '../../src/agent-runtime/runtimes/direct.js';
import { DockerRuntime } from '../../src/agent-runtime/runtimes/docker.js';
import { PortPool } from '../../src/orchestrator/port-pool.js';
import { defaultOrchestratorConfig, dockerOrchestratorConfig, TEST_DOCKER_IMAGE } from '../../src/test-fixtures/ao-configs.js';

export interface E2EServer {
  port: number;
  baseUrl: string;
  workspaceDir: string;
  cleanup: () => Promise<void>;
  orchestratorConfig: OrchestratorConfig;
}

export async function startServer(orchestratorOverrides?: Partial<OrchestratorConfig>): Promise<E2EServer> {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'e2e-ws-'));

  const workspaceConfig = {
    basePath: workspaceDir,
    enforceCanonicalConfig: false,
  };

  const host = process.env.AO_TEST_SERVER_HOST || '127.0.0.1';
  const shutdownTimeoutMs = Number(process.env.AO_TEST_SHUTDOWN_TIMEOUT_MS) || 15000;
  const heartbeatIntervalMs = Number(process.env.AO_TEST_HEARTBEAT_INTERVAL_MS) || 30000;
  const idleTimeoutMs = Number(process.env.AO_TEST_IDLE_TIMEOUT_MS) || 600000;

  const serverConfig = { port: 0, host, shutdownTimeoutMs };
  const wsConfig = { heartbeatIntervalMs, idleTimeoutMs };

  const runtime = orchestratorOverrides?.runtimes?.[0]?.type || process.env.E2E_RUNTIME || 'direct';

  if (runtime === 'docker') {
    const info = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 5000 });
    if (info.status !== 0) throw new Error('Docker is required for docker runtime tests but docker info failed');
    const img = spawnSync('docker', ['inspect', TEST_DOCKER_IMAGE], { stdio: 'ignore', timeout: 5000 });
    if (img.status !== 0) throw new Error(`Docker image ${TEST_DOCKER_IMAGE} not found. Run: docker pull ${TEST_DOCKER_IMAGE}`);
  }

  const baseConfig = runtime === 'docker' ? dockerOrchestratorConfig : defaultOrchestratorConfig;
  const orchestratorConfig: OrchestratorConfig = {
    ...baseConfig,
    ...orchestratorOverrides,
  };

  const workspaceFactory = new WorkspaceFactory(workspaceConfig);

  const runtimeFactory = new RuntimeFactory();
  runtimeFactory.register('direct', DirectRuntime);
  runtimeFactory.register('docker', DockerRuntime);

  const runtimeRegistry = new RuntimeRegistry();
  const portPool = new PortPool(orchestratorConfig.portRange.start, orchestratorConfig.portRange.end, orchestratorConfig.portRange.allowDynamicFallback);
  for (const entry of orchestratorConfig.runtimes) {
    const runtime = runtimeFactory.create(entry.type, portPool, entry.config);
    runtimeRegistry.register(entry.id, runtime);
  }

  const runtimeManager = new RuntimeManager(portPool, runtimeRegistry, orchestratorConfig.defaultAgentType);
  const instanceManager = new InstanceManager(orchestratorConfig, workspaceFactory, runtimeManager);
  const conversationState = new ConversationState();
  const configService = new ConfigService(workspaceFactory, conversationState);
  const agentService = new AgentService(workspaceFactory, conversationState, instanceManager);
  const skillService = new SkillService(workspaceFactory, conversationState);
  const conversationService = new ConversationService(instanceManager, conversationState, workspaceFactory, runtimeManager, serverConfig, orchestratorConfig.defaultAgentType);
  const fileService = new FileService(workspaceFactory, conversationState);
  const sessionService = new SessionService(instanceManager, conversationState);
  const messageService = new MessageService(instanceManager, conversationState);

  const httpServer: HttpServer = createHttpServer(
    serverConfig,
    wsConfig,
    instanceManager,
    workspaceFactory,
    conversationState,
    configService,
    agentService,
    skillService,
    runtimeRegistry,
    conversationService,
    fileService,
    sessionService,
    messageService,
  );

  await instanceManager.cleanupOrphanContainers();

  const cleanup = async () => {
    instanceManager.destroy();
    httpServer.closeWebSockets();
    await new Promise<void>((resolveClose) => {
      httpServer.server.close(() => resolveClose());
    });
    try { rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
    await instanceManager.cleanupOrphanContainers().catch(() => {});
  };

  return new Promise((resolve, reject) => {
    httpServer.server.listen(0, host, () => {
      const addr = httpServer.server.address();
      if (!addr || typeof addr !== 'object') {
        reject(new Error('Failed to get server address'));
        return;
      }
      const port = addr.port;
      serverConfig.port = port;
      resolve({ port, baseUrl: `http://${host}:${port}`, workspaceDir, cleanup, orchestratorConfig });
    });
    httpServer.server.on('error', (err) => {
      reject(err);
    });
  });
}
