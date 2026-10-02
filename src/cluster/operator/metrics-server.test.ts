import { describe, it, expect } from 'vitest';
import { startMetricsServer } from './metrics-server.js';
import { migrationsTotal } from '../../metrics/registry.js';

describe('startMetricsServer', () => {
  it('serves Prometheus metrics including migration outcomes', async () => {
    migrationsTotal.labels('completed').inc();
    const server = await startMetricsServer(0);
    try {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      expect(port).toBeGreaterThan(0);
      const res = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/plain');
      const text = await res.text();
      expect(text).toContain('agentorchestrator_migrations_total');
    } finally {
      server.close();
    }
  });
});
