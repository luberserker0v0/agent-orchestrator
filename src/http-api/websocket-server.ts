import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import type { WebSocketConfig } from '../config-loader.js';
import type { ConversationState } from '../orchestrator/conversation-state.js';
import type { ConfigService } from '../services/config-service.js';
import type { AgentService } from '../services/agent-service.js';
import type { SkillService } from '../services/skill-service.js';
import type { ConversationService } from '../services/conversation-service.js';
import type { FileService } from '../services/file-service.js';
import type { SessionService } from '../services/session-service.js';
import type { MessageService } from '../services/message-service.js';
import type { RoleService } from '../services/role-service.js';
import { WSRouter } from '../websocket/router.js';
import type { AuthContext } from './auth.js';

export interface WebSocketDependencies {
  state: ConversationState;
  config: ConfigService;
  agents: AgentService;
  skills: SkillService;
  conversations: ConversationService;
  files: FileService;
  sessions: SessionService;
  messages: MessageService;
  roles: RoleService;
}

export function attachWebSocketServer(
  server: Server,
  wsConfig: WebSocketConfig,
  dependencies: WebSocketDependencies,
  auth: AuthContext,
): () => void {
  const webSockets = new WebSocketServer({ noServer: true });
  const router = createRouter(webSockets, wsConfig, dependencies, auth);
  server.on('upgrade', (request, socket, head) => {
    if (!(request.url ?? '').startsWith('/ws/')) {
      socket.destroy();
      return;
    }
    if (!authorizeUpgrade(request.url, request.headers.host, request.headers['x-api-key'], auth)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, ws => webSockets.emit('connection', ws, request));
  });
  return () => router.closeAll();
}

function authorizeUpgrade(
  requestUrl: string | undefined,
  host: string | undefined,
  headerKey: string | string[] | undefined,
  auth: AuthContext,
): boolean {
  if (!auth.rbacEnabled) return true;
  const url = new URL(requestUrl ?? '/', `http://${host ?? 'localhost'}`);
  const token = url.searchParams.get('apiKey') ?? (typeof headerKey === 'string' ? headerKey : undefined);
  return Boolean(token && auth.apiKeys?.some(entry => entry.key === token));
}

function createRouter(
  webSockets: WebSocketServer,
  wsConfig: WebSocketConfig,
  deps: WebSocketDependencies,
  auth: AuthContext,
): WSRouter {
  return new WSRouter(
    webSockets, deps.state, wsConfig, deps.config, deps.agents, deps.skills,
    deps.conversations, deps.files, deps.sessions, deps.messages, deps.roles,
    auth.apiKeys, auth.rbacEnabled,
  );
}
