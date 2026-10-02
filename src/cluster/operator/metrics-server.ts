import { createServer, type Server } from 'node:http';
import { metricsRegistry } from '../../metrics/registry.js';
import { logger } from '../../utils/logger.js';

/**
 * Minimal Prometheus scrape endpoint for the placement controller.
 * Shares the process registry (includes Node.js defaults + app metrics).
 */
export async function startMetricsServer(port: number): Promise<Server> {
  const server = createServer(async (_req, res) => {
    try {
      res.writeHead(200, { 'Content-Type': metricsRegistry.contentType });
      res.end(await metricsRegistry.metrics());
    } catch (err) {
      res.writeHead(500);
      res.end(`metrics error: ${(err as Error).message}`);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const addr = server.address();
  logger.info(`[operator] metrics on :${typeof addr === 'object' && addr ? addr.port : port}`);
  return server;
}
