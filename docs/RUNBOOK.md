# Runbook: AgentOrchestrator 維運指南

## 啟動與停止

### 開發模式

```bash
npm run dev
```

### 正式模式

```bash
npm run build && npm start
```

### Docker 部署

```bash
docker build -t agent-orchestrator .
docker run -d --name aor \
  -p 8080:8080 \
  -v /path/to/config:/app/config \
  -e AGENTORCHESTRATOR_SERVER_APIKEY=your-secret-key \
  agent-orchestrator
```

### 優雅關機

發送 `SIGINT`（Ctrl+C）或 `SIGTERM` 信號。伺服器會依序：
1. 停止 idle sweep timer
2. 關閉所有 WebSocket 連線（code 1001）
3. 停止接受新 HTTP 連線
4. 等待進行中的請求完成（最多 `server.shutdownTimeoutMs`）
5. 銷毀所有 OpenCode 實例
6. 退出

---

## 監控

### 健康檢查

```bash
curl http://localhost:8080/health
```

回應：
```json
{ "status": "ok", "uptime": 123.45, "timestamp": "2026-06-17T00:00:00.000Z" }
```

### Prometheus 指標

```bash
curl http://localhost:8080/metrics
```

包含 9 項自訂指標與 Node.js 程序指標。整合 Prometheus：

```yaml
scrape_configs:
  - job_name: 'agentorchestrator'
    static_configs:
      - targets: ['localhost:8080']
    metrics_path: /metrics
```

---

## 設定管理

### 設定檔優先順序

```
config/agentorchestrator.json  <  CLI args  <  環境變數
```

### 常用環境變數

```bash
# 伺服器
AGENTORCHESTRATOR_SERVER_PORT=8080
AGENTORCHESTRATOR_SERVER_HOST=0.0.0.0
AGENTORCHESTRATOR_SERVER_APIKEY=your-secret-key

# 實例上限
AGENTORCHESTRATOR_ORCHESTRATOR_MAX_INSTANCES=20

# Note: `runtimes[]` 陣列不支援環境變數覆寫，多 runtime 或多 Docker 設定請直接修改 JSON 設定檔
```

### 認證啟用

設定 `server.apiKey`（最少 8 字元）後，所有端點（除 `/health`、`/metrics`、`/api-docs*`）需帶入：

```bash
curl -H "Authorization: Bearer your-secret-key" http://localhost:8080/api/conversations
```

---

## 故障排除

### OpenCode 實例無法啟動

```bash
# 檢查 binary 路徑
which opencode

# 檢查端口占用
netstat -an | grep 30000

# 檢查伺服器日誌
# 確認 runtimeConfig.binary 指向正確的可執行檔
```

### 健康檢查失敗

1. 確認 `healthCheck.retries` 與 `healthCheck.intervalMs` 設定合理
2. 確認 `healthCheck.clientTimeoutMs` 夠長（預設 5000ms）
3. Docker 模式下確認容器 image 可執行
4. 確認 `instanceHost` 設定的主機可連接到 OpenCode 實例

### Docker 模式網路問題

- `host` 網路模式：容器直接使用主機網路，跳過 port mapping（OpenCode 實例直接監聽主機端口）
- `bridge` 模式：需要 port mapping，`instanceHost` 應設為 Docker 主機 IP
- 自訂網路：`instanceHost` 應設為容器 IP 或 Docker 主機 IP（取決於網路拓撲）

### WebSocket 連線問題

```
對話未運行：確認已執行 POST /api/conversations/:id/start
未就緒：    等待 conversation.ready 事件後再發送訊息
已斷線：    檢查看 idleTimeoutMs 設定是否過短
```

### 工作階段（Workspace）清理

```bash
# 手動清理所有 workspace
rm -rf workspace/

# 或使用 npm script
npm run clean
```

---

## 定期維運

| 任務 | 頻率 | 方式 |
|------|------|------|
| 檢查日誌 | 每日 | `*.log` 檔案或 stdout |
| 清理殘留 workspace | 必要時 | `npm run clean` |
| 更新相依套件 | 每週 | Dependabot PR 審核合併 |
| 檢查 Prometheus 指標 | 每日 | Grafana 儀表板或 `/metrics` |
| 檢查 Docker 映像更新 | 每月 | `docker pull ghcr.io/anomalyco/opencode:1.17.4` |
| 審閱 API 金鑰 | 每季 | 更新 `server.apiKey` |
