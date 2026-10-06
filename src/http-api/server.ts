import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AgentOrchestratorConfig, ServerConfig, WebSocketConfig } from '../config-loader.js';
import type { InstanceManager } from '../orchestrator/instance-manager.js';
import type { RuntimeRegistry } from '../agent-runtime/registry.js';
import type { WorkspaceFactory } from '../orchestrator/workspace-factory.js';
import type { ConversationState } from '../orchestrator/conversation-state.js';
import type { ConfigService } from '../services/config-service.js';
import type { AgentService } from '../services/agent-service.js';
import type { SkillService } from '../services/skill-service.js';
import type { ConversationService } from '../services/conversation-service.js';
import type { FileService } from '../services/file-service.js';
import type { SessionService } from '../services/session-service.js';
import type { MessageService } from '../services/message-service.js';
import type { RoleService } from '../services/role-service.js';
import type { CleanupManager } from '../cleanup/cleanup-manager.js';
import { mountDashboard } from './dashboard.js';
import { installAuth } from './auth.js';
import { installErrorHandler, installTransportMiddleware } from './middleware.js';
import { RequestTracker } from './request-tracker.js';
import { attachWebSocketServer } from './websocket-server.js';
import { registerSystemRoutes } from './routes/system-routes.js';
import { registerAdminRoutes } from './routes/admin-routes.js';
import { registerConversationRoutes } from './routes/conversation-routes.js';
import { registerConfigRoutes } from './routes/config-routes.js';
import { registerAgentRoutes } from './routes/agent-routes.js';
import { registerFileRoutes } from './routes/file-routes.js';
import { registerSessionRoutes } from './routes/session-routes.js';
import { registerSkillRoutes } from './routes/skill-routes.js';

export interface HttpServer {
  server: Server;
  closeWebSockets: () => void;
  waitForRequests: (timeoutMs: number) => Promise<void>;
}

export function createHttpServer(
  serverConfig: ServerConfig,
  wsConfig: WebSocketConfig,
  _instanceManager: InstanceManager,
  _workspaceFactory: WorkspaceFactory,
  conversationState: ConversationState,
  configService: ConfigService,
  agentService: AgentService,
  skillService: SkillService,
  runtimeRegistry: RuntimeRegistry,
  conversationService: ConversationService,
  fileService: FileService,
  sessionService: SessionService,
  messageService: MessageService,
  roleService: RoleService,
  config: AgentOrchestratorConfig,
  cleanupManager?: CleanupManager,
): HttpServer {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(express.text({ limit: '5mb' }));

  const requests = new RequestTracker();
  app.use(requests.middleware);
  installTransportMiddleware(app);
  const auth = installAuth(app, serverConfig, roleService);
  mountDashboard(app);

  registerSystemRoutes(app, config, runtimeRegistry, auth);
  registerAdminRoutes(app, roleService, cleanupManager);
  registerConversationRoutes(app, conversationService);
  registerConfigRoutes(app, conversationState, configService);
  registerAgentRoutes(app, conversationState, agentService);
  registerFileRoutes(app, conversationState, fileService);
  registerSessionRoutes(app, sessionService, messageService);
  registerSkillRoutes(app, conversationState, skillService);
  installErrorHandler(app);

  const server = createServer(app);
  const closeWebSockets = attachWebSocketServer(server, wsConfig, {
    state: conversationState,
    config: configService,
    agents: agentService,
    skills: skillService,
    conversations: conversationService,
    files: fileService,
    sessions: sessionService,
    messages: messageService,
    roles: roleService,
  }, auth);

  return {
    server,
    closeWebSockets,
    waitForRequests: timeoutMs => requests.waitForIdle(timeoutMs),
  };
}
