import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createHttpServer } from '../http-api/server.js';
import {
  metricsRegistry,
  instancesActive,
  instancesTotalCreated,
} from './registry.js';

describe('Metrics', () => {
  it('exposes /metrics endpoint with correct content type', async () => {
    const server = createHttpServer(
      { port: 0, host: '127.0.0.1' },
      { heartbeatIntervalMs: 30000, idleTimeoutMs: 600000 },
      {
        createInstance: vi.fn(),
        destroyInstance: vi.fn(),
        listInstances: vi.fn(),
        getInstance: vi.fn(),
      } as any,
      { opencodeBinary: 'opencode', maxInstances: 10, idleTimeoutMs: 600000, idleSweepIntervalMs: 60000, portRange: { start: 30000, end: 30100 }, healthCheck: { retries: 10, intervalMs: 500 } }
    );

    const res = await request(server).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('nodejs_');

    server.close();
  });

  it('registers custom gauges and counters', async () => {
    const metrics = await metricsRegistry.getMetricsAsJSON();
    const names = metrics.map((m: { name: string }) => m.name);

    expect(names).toContain('agentorchestrator_instances_active');
    expect(names).toContain('agentorchestrator_instances_total_created');
    expect(names).toContain('agentorchestrator_port_pool_available');
    expect(names).toContain('agentorchestrator_websocket_connections_active');
    expect(names).toContain('agentorchestrator_http_requests_total');
  });

  it('updates gauge values correctly', async () => {
    instancesActive.set(5);
    const result1 = await instancesActive.get();
    expect(result1.values[0].value).toBe(5);

    instancesActive.inc();
    const result2 = await instancesActive.get();
    expect(result2.values[0].value).toBe(6);

    instancesActive.dec();
    const result3 = await instancesActive.get();
    expect(result3.values[0].value).toBe(5);

    instancesActive.set(0);
  });

  it('increments counter correctly', async () => {
    const before = await instancesTotalCreated.get();
    const beforeValue = before.values[0]?.value ?? 0;
    instancesTotalCreated.inc();
    const after = await instancesTotalCreated.get();
    expect(after.values[0].value).toBe(beforeValue + 1);
  });
});
