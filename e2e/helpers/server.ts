import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer, type HttpServer } from '../../src/http-api/server.js';
import { WorkspaceFactory } from '../../src/orchestrator/workspace-factory.js';
import { InstanceManager } from '../../src/orchestrator/instance-manager.js';
import { ConversationState } from '../../src/orchestrator/conversation-state.js';

export interface E2EServer {
  port: number;
  baseUrl: string;
  cleanup: () => Promise<void>;
}

export function startServer(): Promise<E2EServer> {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'e2e-ws-'));

  const workspaceConfig = {
    basePath: workspaceDir,
    defaultPermissions: {
      external_directory: { '*': 'deny' },
      bash: { '*': 'deny' },
    },
  };

  const serverConfig = { port: 0, host: '127.0.0.1', shutdownTimeoutMs: 15000 };
  const wsConfig = { heartbeatIntervalMs: 30000, idleTimeoutMs: 600000 };
  const orchestratorConfig = {
    maxInstances: 5,
    idleTimeoutMs: 600000,
    idleSweepIntervalMs: 60000,
    portRange: { start: 30000, end: 30050 },
    opencodeBinary: 'opencode',
    healthCheck: { retries: 10, intervalMs: 500 },
  };

  const workspaceFactory = new WorkspaceFactory(workspaceConfig);
  const instanceManager = new InstanceManager(orchestratorConfig, workspaceFactory);
  const conversationState = new ConversationState();

  const httpServer: HttpServer = createHttpServer(
    serverConfig,
    wsConfig,
    instanceManager,
    workspaceFactory,
    conversationState,
    orchestratorConfig,
  );

  return new Promise((resolve, reject) => {
    httpServer.server.listen(0, '127.0.0.1', () => {
      const addr = httpServer.server.address();
      if (!addr || typeof addr !== 'object') {
        reject(new Error('Failed to get server address'));
        return;
      }
      const port = addr.port;
      serverConfig.port = port;

      const cleanup = async () => {
        instanceManager.destroy();
        httpServer.closeWebSockets();
        await new Promise<void>((resolveClose) => {
          httpServer.server.close(() => resolveClose());
        });
        try { rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
      };

      resolve({ port, baseUrl: `http://127.0.0.1:${port}`, cleanup });
    });
    httpServer.server.on('error', (err) => {
      reject(err);
    });
  });
}
