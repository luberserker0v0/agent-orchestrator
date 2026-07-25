# Monitoring

AgentOrchestrator exposes Prometheus-compatible metrics for monitoring.

## Metrics Endpoint

```bash
curl http://localhost:8080/metrics
```

## Available Metrics

### Instance Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `agentorchestrator_instances_active` | Gauge | Currently active OpenCode instances |
| `agentorchestrator_instances_total_created` | Counter | Total instances created since startup |
| `agentorchestrator_instances_errors_total` | Counter | Total instance errors (labels: type) |
| `agentorchestrator_instance_spawn_duration_seconds` | Histogram | Time to spawn an instance |

### Port Pool Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `agentorchestrator_port_pool_available` | Gauge | Available ports in the pool |

### WebSocket Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `agentorchestrator_websocket_connections_active` | Gauge | Active WebSocket connections |

### HTTP Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `agentorchestrator_http_requests_total` | Counter | Total HTTP requests (labels: method, status) |
| `agentorchestrator_http_request_duration_seconds` | Histogram | HTTP request duration (labels: method, status) |

### Conversation Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `agentorchestrator_conversation_state_changes_total` | Counter | State transitions (labels: status) |

### Node.js Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `nodejs_heap_size_bytes` | Gauge | Heap memory usage |
| `nodejs_rss_bytes` | Gauge | Resident set size |
| `nodejs_event_loop_lag_seconds` | Gauge | Event loop lag |
| `nodejs_gc_duration_seconds` | Histogram | GC pause duration |

## Prometheus Configuration

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'agent-orchestrator'
    static_configs:
      - targets: ['localhost:8080']
    metrics_path: /metrics
    scrape_interval: 15s
```

## Suggested Alerting Rules

```yaml
# alerts.yml
groups:
  - name: agent-orchestrator
    rules:
      # Instance errors spike
      - alert: HighInstanceErrors
        expr: rate(agentorchestrator_instances_errors_total[5m]) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High instance error rate"

      # All instances busy
      - alert: InstanceCapacityHigh
        expr: agentorchestrator_instances_active >= 9
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Instance capacity near limit"

      # No available ports
      - alert: NoAvailablePorts
        expr: agentorchestrator_port_pool_available == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "No available ports for new instances"

      # High memory usage
      - alert: HighMemoryUsage
        expr: nodejs_heap_size_bytes / nodejs_heap_size_total_bytes > 0.85
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High heap memory usage"

      # Server down
      - alert: AgentOrchestratorDown
        expr: up{job="agent-orchestrator"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "AgentOrchestrator is down"
```

## Grafana Dashboard

Key panels to create:

| Panel | Query | Type |
|-------|-------|------|
| Active Instances | `agentorchestrator_instances_active` | Gauge |
| Instance Creation Rate | `rate(agentorchestrator_instances_total_created[5m])` | Graph |
| Error Rate | `rate(agentorchestrator_instances_errors_total[5m])` | Graph |
| HTTP Request Rate | `rate(agentorchestrator_http_requests_total[5m])` | Graph |
| HTTP Latency (p95) | `histogram_quantile(0.95, rate(agentorchestrator_http_request_duration_seconds_bucket[5m]))` | Graph |
| Available Ports | `agentorchestrator_port_pool_available` | Gauge |
| WebSocket Connections | `agentorchestrator_websocket_connections_active` | Gauge |
| Heap Memory | `nodejs_heap_size_bytes` | Graph |
| Event Loop Lag | `nodejs_event_loop_lag_seconds` | Graph |
