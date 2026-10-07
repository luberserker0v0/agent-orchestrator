import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, type OrchestratorConfig, type AgentOrchestratorConfig } from '../../src/config-loader.js';
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
import { RoleService } from '../../src/services/role-service.js';
import { RuntimeRegistry } from '../../src/agent-runtime/registry.js';
import { RuntimeFactory } from '../../src/agent-runtime/runtime-factory.js';
import { DirectRuntime } from '../../src/agent-runtime/runtimes/direct.js';
import { DockerRuntime } from '../../src/agent-runtime/runtimes/docker.js';
import { PortPool } from '../../src/orchestrator/port-pool.js';
import { LocalStorage } from '../../src/storage/local.js';
import { defaultOrchestratorConfig, dockerOrchestratorConfig, TEST_DOCKER_IMAGE } from '../../src/test-fixtures/ao-configs.js';

const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69,
  77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119,
  123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990,
  993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000,
  6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

export interface E2EServer {
  port: number;
  baseUrl: string;
  workspaceDir: string;
  cleanup: () => Promise<void>;
  orchestratorConfig: OrchestratorConfig;
  crashInstance: (id: string) => Promise<void>;
}

export async function startServer(orchestratorOverrides?: Partial<OrchestratorConfig>): Promise<E2EServer> {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'e2e-ws-'));

  const workspaceConfig = {
    basePath: workspaceDir,
    enforceCanonicalConfig: false,
    storage: { type: 'local' as const },
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
  const configuredOrchestrator: OrchestratorConfig = {
    ...baseConfig,
    ...orchestratorOverrides,
  };
  const orchestratorConfig = withDockerHostIdentity(configuredOrchestrator);

  const storage = new LocalStorage(workspaceConfig.basePath);
  const workspaceFactory = new WorkspaceFactory(workspaceConfig, storage);

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
  runtimeManager.setOnDestroyed((id: string) => {
    const state = conversationState.get(id);
    if (!state) return;
    if (state.status === 'stopped' || state.status === 'destroyed' || state.status === 'restarting') return;
    conversationState.cancelReadyCheck(id);
    conversationState.transition(id, 'stopped');
    conversationState.removeRunningInstance(id);
  });
  const configService = new ConfigService(workspaceFactory, conversationState);
  const agentService = new AgentService(workspaceFactory, conversationState, instanceManager);
  const skillService = new SkillService(workspaceFactory, conversationState);
  const conversationService = new ConversationService(instanceManager, conversationState, workspaceFactory, runtimeManager, serverConfig, orchestratorConfig.defaultAgentType);
  const fileService = new FileService(workspaceFactory, conversationState);
  const sessionService = new SessionService(instanceManager, conversationState);
  const messageService = new MessageService(instanceManager, conversationState);

  const fullConfig: AgentOrchestratorConfig = {
    server: serverConfig,
    websocket: wsConfig,
    orchestrator: orchestratorConfig,
    workspace: workspaceConfig,
    logging: defaultConfig().logging,
    cleanup: defaultConfig().cleanup,
  };
  const roleService = new RoleService(join(workspaceDir, 'agentorchestrator.json'), fullConfig.roles);

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
    roleService,
    fullConfig,
  );

  await instanceManager.cleanupOrphanContainers();

  const crashInstance = async (id: string): Promise<void> => {
    const inst = runtimeManager.getInstance(id);
    if (!inst?.handle) {
      throw new Error(`Instance ${id} not found or has no handle`);
    }
    await inst.handle.kill('SIGKILL');
  };

  const cleanup = async () => {
    instanceManager.destroy();
    httpServer.closeWebSockets();
    await new Promise<void>((resolveClose) => {
      httpServer.server.close(() => resolveClose());
    });
    try { rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
    await instanceManager.cleanupOrphanContainers().catch(() => {});
  };

  return listenOnFetchSafePort(
    httpServer,
    host,
    (port) => {
      serverConfig.port = port;
      return { port, baseUrl: `http://${host}:${port}`, workspaceDir, cleanup, orchestratorConfig, crashInstance };
    },
  );
}

function withDockerHostIdentity(config: OrchestratorConfig): OrchestratorConfig {
  if (process.platform === 'win32' || !process.getuid || !process.getgid) return config;
  const containerUser = `${process.getuid()}:${process.getgid()}`;
  return {
    ...config,
    runtimes: config.runtimes.map((entry) => entry.type === 'docker'
      ? {
        ...entry,
        config: {
          ...entry.config,
          containerUser,
          containerHome: '/tmp/agentorchestrator-home',
        },
      }
      : entry),
  };
}

function listenOnFetchSafePort(
  httpServer: HttpServer,
  host: string,
  createResult: (port: number) => E2EServer,
): Promise<E2EServer> {
  return new Promise((resolve, reject) => {
    httpServer.server.once('error', reject);
    const listen = () => {
      httpServer.server.listen(0, host, () => {
        const address = httpServer.server.address();
        if (!address || typeof address !== 'object') {
          reject(new Error('Failed to get server address'));
          return;
        }
        if (FETCH_BLOCKED_PORTS.has(address.port)) {
          httpServer.server.close(listen);
          return;
        }
        resolve(createResult(address.port));
      });
    };
    listen();
  });
}
