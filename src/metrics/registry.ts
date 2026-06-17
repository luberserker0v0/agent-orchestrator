import { Registry, Gauge, Counter, Histogram, collectDefaultMetrics } from 'prom-client';

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

export const instancesErrorsTotal = new Counter({
  name: 'agentorchestrator_instances_errors_total',
  help: 'Total instance errors',
  labelNames: ['type'],
  registers: [metricsRegistry],
});

export const instanceSpawnDurationSeconds = new Histogram({
  name: 'agentorchestrator_instance_spawn_duration_seconds',
  help: 'Time to spawn an OpenCode instance',
  buckets: [1, 2, 5, 10, 30, 60],
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

export const httpRequestDurationSeconds = new Histogram({
  name: 'agentorchestrator_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [metricsRegistry],
});

export const conversationStateChangesTotal = new Counter({
  name: 'agentorchestrator_conversation_state_changes_total',
  help: 'Total conversation state transitions',
  labelNames: ['status'],
  registers: [metricsRegistry],
});
