import { Registry, Gauge, Counter, collectDefaultMetrics } from 'prom-client';

export const metricsRegistry = new Registry();

collectDefaultMetrics({ register: metricsRegistry });

export const instancesActive = new Gauge({
  name: 'agentorchestrator_instances_active',
  help: 'Currently active OpenCode instances',
  registers: [metricsRegistry],
});

export const instancesTotalCreated = new Counter({
  name: 'agentorchestrator_instances_total_created',
  help: 'Total OpenCode instances created since startup',
  registers: [metricsRegistry],
});

export const portPoolAvailable = new Gauge({
  name: 'agentorchestrator_port_pool_available',
  help: 'Available ports in the pool',
  registers: [metricsRegistry],
});

export const wsConnectionsActive = new Gauge({
  name: 'agentorchestrator_websocket_connections_active',
  help: 'Active WebSocket connections',
  registers: [metricsRegistry],
});

export const httpRequestsTotal = new Counter({
  name: 'agentorchestrator_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'status'],
  registers: [metricsRegistry],
});
