import { K8sStatusReporter } from '../cluster/status-reporter.js';
import type { AgentOrchestratorConfig } from '../config-loader.js';
import { loadCanonicalConfig } from '../config-loader.js';
import { InstanceManager } from '../orchestrator/instance-manager.js';
import { ConversationState } from '../orchestrator/conversation-state.js';
import { SSEBridge } from '../orchestrator/sse-bridge.js';
import { WorkspaceFactory } from '../orchestrator/workspace-factory.js';
import { AgentService } from '../services/agent-service.js';
import { ConfigService } from '../services/config-service.js';
import { ConversationService } from '../services/conversation-service.js';
import { FileService } from '../services/file-service.js';
import { MessageService } from '../services/message-service.js';
import { RoleService } from '../services/role-service.js';
import { SessionService } from '../services/session-service.js';
import { SkillService } from '../services/skill-service.js';
import { LocalStorage } from '../storage/index.js';
import type { StorageBackend } from '../storage/types.js';
import { isRunningInContainer } from '../utils/is-container.js';
import { logger } from '../utils/logger.js';
import type { RuntimeEnvironment } from './runtime-environment.js';

export interface ApplicationServices {
  workspaceFactory: WorkspaceFactory;
  instanceManager: InstanceManager;
  conversationState: ConversationState;
  configService: ConfigService;
  agentService: AgentService;
  skillService: SkillService;
  conversationService: ConversationService;
  fileService: FileService;
  sessionService: SessionService;
  messageService: MessageService;
  roleService: RoleService;
  statusReporter: K8sStatusReporter;
}

export function createStorage(config: AgentOrchestratorConfig): StorageBackend {
  if (config.workspace.storage.type === 'local') {
    return new LocalStorage(config.workspace.basePath);
  }
  throw new Error(`Unsupported storage type: ${(config.workspace.storage as { type: string }).type}`);
}

export async function createApplicationServices(
  config: AgentOrchestratorConfig,
  configPath: string | undefined,
  storage: StorageBackend,
  runtimes: RuntimeEnvironment,
): Promise<ApplicationServices> {
  const canonicalConfig = loadCanonicalConfig(config.workspace.enforceCanonicalConfig);
  const workspaceFactory = new WorkspaceFactory(config.workspace, storage, canonicalConfig);
  const conversationState = new ConversationState();
  const sseBridge = new SSEBridge(conversationState, config.orchestrator.sse);
  runtimes.manager.setOnDestroyed(id => transitionDestroyedRuntime(id, conversationState, sseBridge));
  const instanceManager = new InstanceManager(config.orchestrator, workspaceFactory, runtimes.manager);
  const statusReporter = await K8sStatusReporter.create(config.cluster);
  const runtimeTypeById = new Map(config.orchestrator.runtimes.map(entry => [entry.id, entry.type]));
  const conversationService = new ConversationService(
    instanceManager,
    conversationState,
    workspaceFactory,
    runtimes.manager,
    config.server,
    config.orchestrator.defaultAgentType,
    sseBridge,
    statusReporter,
    agentTypeId => runtimeTypeById.get(agentTypeId),
  );
  return {
    workspaceFactory,
    instanceManager,
    conversationState,
    configService: new ConfigService(workspaceFactory, conversationState),
    agentService: new AgentService(workspaceFactory, conversationState, instanceManager),
    skillService: new SkillService(workspaceFactory, conversationState),
    conversationService,
    fileService: new FileService(workspaceFactory, conversationState),
    sessionService: new SessionService(instanceManager, conversationState),
    messageService: new MessageService(instanceManager, conversationState, statusReporter),
    roleService: new RoleService(configPath ?? 'config/agentorchestrator.json', config.roles),
    statusReporter,
  };
}

export function validateContainerDeployment(config: AgentOrchestratorConfig): void {
  if (!isRunningInContainer()) return;
  const defaultEntry = config.orchestrator.runtimes.find(
    runtime => runtime.id === config.orchestrator.defaultAgentType,
  );
  const problem = validateContainerRuntimeStorage(defaultEntry?.type, config.workspace.storage.type);
  if (problem) throw new Error(problem);
  warnAboutContainerWorkspace(config, defaultEntry?.type, defaultEntry?.config.instanceHost);
}

export function validateContainerRuntimeStorage(
  defaultRuntimeType: string | undefined,
  storageType: string,
): string | undefined {
  if (storageType !== 'local') return undefined;
  if (!defaultRuntimeType || defaultRuntimeType === 'direct' || defaultRuntimeType === 'kubernetes') {
    return undefined;
  }
  return (
    'AO is running inside a container with default runtime type "' + defaultRuntimeType + '" ' +
    'but workspace.storage is "local". Container-based agent instances cannot access ' +
    'the AO container\'s local filesystem. Set workspace.storage to a non-local type ' +
    '(e.g., "docker-volume") that supports volume sharing between containers.'
  );
}

function transitionDestroyedRuntime(
  id: string,
  conversationState: ConversationState,
  sseBridge: SSEBridge,
): void {
  const state = conversationState.get(id);
  if (!state || state.status === 'stopped' || state.status === 'destroyed' || state.status === 'restarting') return;
  sseBridge.stop(id);
  conversationState.cancelReadyCheck(id);
  conversationState.transition(id, 'stopped');
  conversationState.removeRunningInstance(id);
}

function warnAboutContainerWorkspace(
  config: AgentOrchestratorConfig,
  runtimeType: string | undefined,
  instanceHost: unknown,
): void {
  if (runtimeType === 'kubernetes' && config.workspace.storage.type === 'local') {
    logger.warn(
      'AO is running inside a container with Kubernetes runtime and local workspace storage. ' +
      'Instance sessions travel via per-conversation PVCs, but workspace file APIs operate on ' +
      'the orchestrator local disk — files written via the API are not visible inside instances.',
    );
  }
  if (runtimeType === 'docker' && !instanceHost) {
    logger.warn(
      'AO is running inside a container with Docker runtime. The default instanceHost "127.0.0.1" ' +
      'may not reach OpenCode containers. Set instanceHost to "host.docker.internal" or use ' +
      'networkMode "host" in your runtime config if SSE events are not received.',
    );
  }
}
