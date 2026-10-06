import type { Express, Request, Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import type { AgentOrchestratorConfig } from '../../config-loader.js';
import type { RuntimeRegistry } from '../../agent-runtime/registry.js';
import { metricsRegistry } from '../../metrics/registry.js';
import { openapiSpec } from '../openapi.js';
import type { AuthContext } from '../auth.js';

export function registerSystemRoutes(
  app: Express,
  config: AgentOrchestratorConfig,
  runtimes: RuntimeRegistry,
  auth: AuthContext,
): void {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapiSpec, {
    customSiteTitle: 'AgentOrchestrator API Docs',
  }));
  app.get('/api-docs.json', (_req, res) => res.json(openapiSpec));
  app.get('/health', health);
  app.get('/metrics', metrics);
  app.get('/api/runtimes', (_req, res) => res.json(runtimeDetails(config, runtimes)));
  app.get('/api/auth/role', (req: Request, res: Response) => {
    if (!auth.rbacEnabled) {
      res.json({ role: 'admin', name: 'local' });
      return;
    }
    res.json({ role: req.apiKeyRole ?? 'admin', name: req.apiKeyName ?? '' });
  });
}

function health(_req: Request, res: Response): void {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
}

async function metrics(_req: Request, res: Response): Promise<void> {
  res.set('Content-Type', metricsRegistry.contentType);
  res.end(await metricsRegistry.metrics());
}

function runtimeDetails(config: AgentOrchestratorConfig, registry: RuntimeRegistry): unknown[] {
  return config.orchestrator.runtimes.map(entry => {
    const validity = registry.getValidity(entry.id);
    const runtime = validity?.isValid ? registry.get(entry.id) : undefined;
    const version = entry.type === 'direct'
      ? entry.config.version
      : entry.config.image?.split(':')[1];
    return {
      id: entry.id,
      type: entry.type,
      version,
      config: entry.config,
      registered: registry.has(entry.id),
      isValid: validity?.isValid ?? false,
      error: validity?.isValid ? undefined : validity?.error,
      capabilities: runtime?.capabilities ?? null,
    };
  });
}
