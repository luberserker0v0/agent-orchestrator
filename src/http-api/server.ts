import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import type { ServerConfig, WebSocketConfig } from '../config-loader.js';
import type { OrchestratorConfig } from '../config-loader.js';
import { InstanceManager } from '../orchestrator/instance-manager.js';
import { listModels } from '../opencode-cli/models.js';
import { WSRouter } from '../websocket/router.js';
import { logger } from '../utils/logger.js';
import { metricsRegistry, httpRequestsTotal } from '../metrics/registry.js';

export function createHttpServer(
  serverConfig: ServerConfig,
  wsConfig: WebSocketConfig,
  instanceManager: InstanceManager,
  orchestratorConfig: OrchestratorConfig
): Server {
  const app = express();
  app.use(express.json());

  // HTTP request counter middleware
  app.use((req, res, next) => {
    res.on('finish', () => {
      httpRequestsTotal.inc({ method: req.method, status: String(res.statusCode) });
    });
    next();
  });

  // CORS
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }
    next();
  });

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
  });

  // Prometheus metrics endpoint
  app.get('/metrics', async (_req: Request, res: Response) => {
    res.set('Content-Type', metricsRegistry.contentType);
    res.end(await metricsRegistry.metrics());
  });

  // Create conversation
  app.post('/api/conversations', async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const id = req.body.id ?? generateId();
      const model = typeof req.body.model === 'string' ? req.body.model : undefined;
      const agent = typeof req.body.agent === 'string' ? req.body.agent : undefined;
      const instance = await instanceManager.createInstance(id, { model, agent });
      const wsUrl = `ws://${serverConfig.host}:${serverConfig.port}/ws/${id}`;
      res.status(201).json({
        id: instance.id,
        wsUrl,
        port: instance.port,
        sessionId: instance.sessionId,
        model: instance.defaultModel,
        agent: instance.defaultAgent,
      });
    } catch (err) {
      logger.error('Failed to create conversation:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // List available models
  app.get('/api/models', async (_req: Request, res: Response) => {
    try {
      const models = await listModels(orchestratorConfig.opencodeBinary);
      res.json(models);
    } catch (err) {
      logger.error('Failed to list models:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Delete conversation
  app.delete('/api/conversations/:id', async (req: Request, res: Response) => {
    try {
      await instanceManager.destroyInstance(req.params.id);
      res.status(204).send();
    } catch (err) {
      logger.error('Failed to delete conversation:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // List conversations
  app.get('/api/conversations', (_req: Request, res: Response) => {
    res.json(instanceManager.listInstances());
  });

  // Global error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('HTTP error:', err);
    res.status(500).json({ error: err.message });
  });

  const httpServer = createServer(app);

  // WebSocket server - manual upgrade handling for dynamic paths
  const wss = new WebSocketServer({ noServer: true });
  new WSRouter(wss, instanceManager, wsConfig);

  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = request.url ?? '';
    if (pathname.startsWith('/ws/')) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  return httpServer;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
