# API 文件

AgentOrchestrator 提供 REST API 與 WebSocket API（JSON-RPC 2.0）兩種介面。

---

## REST API

### `GET /health`

健康檢查。

**回應**：
```json
{ "status": "ok", "uptime": 12.34, "timestamp": "2026-06-03T14:45:22.734Z" }
```

---

### `POST /api/conversations`

建立新對話。AgentOrchestrator 會：
1. 建立 `workspace/{id}/` 資料夾
2. 寫入 `opencode.json` 權限設定
3. 分配動態端口並啟動 `opencode serve`
4. 等待健康檢查通過
5. 建立初始 Session

**請求**：
```json
{
  "id": "my-conversation-001",
  "model": "anthropic/claude-3-5-sonnet",
  "agent": "build"
}
```
- `id`：可省略，由系統自動生成 UUID
- `model`（可選）：指定該對話的預設模型，格式為 `providerID/modelID`，寫入 `opencode.json`
- `agent`（可選）：指定該對話的預設代理

**回應**（`201 Created`）：
```json
{
  "id": "my-conversation-001",
  "wsUrl": "ws://127.0.0.1:11697/ws/my-conversation-001",
  "port": 30000,
  "sessionId": "ses_171df93daffektj6tWpV4EBEmz",
  "model": "anthropic/claude-3-5-sonnet",
  "agent": "build"
}
```

**錯誤**（`500`）：
```json
{ "error": "OpenCode instance failed health check after 10 retries" }
```

---

### `GET /api/models`

列出所有已設定供應商中可用的模型。透過執行 `opencode models` CLI 取得。

**回應**：
```json
[
  { "id": "anthropic/claude-3-5-sonnet", "provider": "anthropic", "model": "claude-3-5-sonnet" },
  { "id": "openai/gpt-5", "provider": "openai", "model": "gpt-5" }
]
```

**錯誤**（`500`）：
```json
{ "error": "Failed to list models" }
```

---

### `DELETE /api/conversations/:id`

刪除對話。終止 OpenCode 進程、釋放端口、移除 workspace。

**回應**：`204 No Content`

---

### `GET /api/conversations`

列出所有活躍對話。

**回應**：
```json
[
  {
    "id": "my-conversation-001",
    "port": 30000,
    "lastUsedAt": 1780500965587,
    "isReady": true
  }
]
```

---

## WebSocket API（JSON-RPC 2.0）

連線 URL：`ws://<host>:<port>/ws/<conversationId>`

所有訊息採用 JSON-RPC 2.0 格式。

### `message.send`

發送使用者訊息，等待 OpenCode AI 回應。OpenCode 會自動處理內建 tool calling loop（如 `read`/`edit`）。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "message.send",
  "params": {
    "text": "Hello, what can you do?",
    "model": "anthropic/claude-3-5-sonnet",
    "agent": "build"
  }
}
```
- `text`（必填）：使用者訊息內容
- `model`（可選）：覆寫對話預設模型，格式為 `providerID/modelID`。若省略，使用對話建立時設定的預設模型；若對話也無預設，則使用 OpenCode 全域預設
- `agent`（可選）：覆寫對話預設代理。若省略，使用對話建立時設定的預設代理

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "messageId": "msg_xxx",
    "text": "I can help you with ...",
    "parts": [
      { "type": "text", "text": "I can help you with ..." }
    ]
  }
}
```

---

### `message.history`

取得對話歷史。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "message.history",
  "params": { "limit": 10 }
}
```

**回應**：陣列，包含完整訊息結構（含 `info` 與 `parts`）。

---

### `session.abort`

中止當前正在生成的 AI 回應。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session.abort",
  "params": {}
}
```

**回應**：
```json
{ "jsonrpc": "2.0", "id": 3, "result": { "aborted": true } }
```

---

## 錯誤處理

REST API 與 WebSocket API 的錯誤回應格式：

**REST HTTP 錯誤**：
```json
{ "error": "錯誤訊息" }
```

**WebSocket JSON-RPC 錯誤**：
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": { "code": -32000, "message": "錯誤訊息" }
}
```

常見錯誤碼：

| 錯誤碼 | 說明 |
|--------|------|
| `-32700` | Parse error：無法解析 JSON |
| `-32600` | Invalid Request：jsonrpc 版本不對或缺少 method |
| `-32601` | Method not found：未知的 WebSocket method |
| `-32000` | Server error：一般伺服器錯誤 |
