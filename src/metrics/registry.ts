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

export const opencodeHttpRequestsTotal = new Counter({
  name: 'agentorchestrator_opencode_http_requests_total',
  help: 'Total OpenCode HTTP proxy requests',
  labelNames: ['method', 'path', 'status'],
  registers: [metricsRegistry],
});

export const opencodeHttpRequestDurationSeconds = new Histogram({
  name: 'agentorchestrator_opencode_http_request_duration_seconds',
  help: 'OpenCode HTTP proxy request duration in seconds',
  labelNames: ['method', 'path'],
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

export const sseConnectionsActive = new Gauge({
  name: 'agentorchestrator_sse_connections_active',
  help: 'Active SSE connections to OpenCode instances',
  registers: [metricsRegistry],
});

export const sseReconnectTotal = new Counter({
  name: 'agentorchestrator_sse_reconnect_total',
  help: 'Total SSE reconnection attempts',
  labelNames: ['status'],
  registers: [metricsRegistry],
});

export const messagesSentTotal = new Counter({
  name: 'agentorchestrator_messages_sent_total',
  help: 'Total messages sent to OpenCode instances',
  labelNames: ['status'],
  registers: [metricsRegistry],
});

export const messageSendDurationSeconds = new Histogram({
  name: 'agentorchestrator_message_send_duration_seconds',
  help: 'Duration of message send operations in seconds',
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

export const instanceEvictionsTotal = new Counter({
  name: 'agentorchestrator_instance_evictions_total',
  help: 'Total LRU instance evictions',
  registers: [metricsRegistry],
});

export const instanceIdleTimeoutsTotal = new Counter({
  name: 'agentorchestrator_instance_idle_timeouts_total',
  help: 'Total idle timeout instance destructions',
  registers: [metricsRegistry],
});

export const workspacesActive = new Gauge({
  name: 'agentorchestrator_workspaces_active',
  help: 'Currently active workspaces',
  registers: [metricsRegistry],
});

export const workspaceQuotaExceededTotal = new Counter({
  name: 'agentorchestrator_workspace_quota_exceeded_total',
  help: 'Total workspace quota exceeded errors',
  registers: [metricsRegistry],
});
