# API 文件

AgentOrchestrator 提供 REST API 與 WebSocket API（JSON-RPC 2.0）兩種介面。

---

## REST API

### `GET /health`

健康檢查。

**回應**：
```json
{ "status": "ok", "uptime": 12.34, "timestamp": "2026-06-05T14:45:22.734Z" }
```

---

### `GET /metrics`

Prometheus 指標端點，暴露 AgentOrchestrator 與 Node.js 執行時期指標。

**回應**（`text/plain`）：Prometheus exposition format

| Metric | Type | Description |
|--------|------|-------------|
| `agentorchestrator_instances_active` | Gauge | 目前活躍的 OpenCode 實例數 |
| `agentorchestrator_instances_total_created` | Counter | 啟動以來建立的總實例數 |
| `agentorchestrator_port_pool_available` | Gauge | 動態端口池中可用端口數 |
| `agentorchestrator_websocket_connections_active` | Gauge | 活躍的 WebSocket 連線數 |
| `agentorchestrator_http_requests_total` | Counter | 總 HTTP 請求數（labels: method, status） |
| `nodejs_*` | Various | Node.js 程序指標（memory, CPU, GC, event loop） |

---

### `POST /api/conversations`

準備新對話。僅建立 workspace，**不啟動** OpenCode 實例。

**請求**：
```json
{
  "id": "my-conversation-001"
}
```
- `id`：可省略，由系統自動生成 UUID

**回應**（`201 Created`）：
```json
{
  "id": "my-conversation-001",
  "status": "prepared",
  "wsUrl": "ws://127.0.0.1:11697/ws/my-conversation-001"
}
```

**錯誤**（`500`）：
```json
{ "error": "Failed to create conversation: disk full" }
```

---

### `POST /api/conversations/:id/start`

啟動對話的 OpenCode 實例。若 workspace 已存在則直接重用。

**請求**：空 body

**回應**（`200 OK`）：
```json
{
  "status": "running",
  "ready": false,
  "port": 30000,
  "sessionId": "ses_171df93daffektj6tWpV4EBEmz"
}
```

> `ready` 初始為 `false`，表示 OpenCode 尚未完成初始化。監聽 `conversation.ready` 事件以獲得就緒通知。

**錯誤**：
- `404`：對話不存在
  ```json
  { "error": "Conversation not found" }
  ```
- `409`：已經在運行
  ```json
  { "error": "Conversation already running" }
  ```
- `500`：啟動失敗（spawn 錯誤、健康檢查失敗等）
  ```json
  { "error": "OpenCode instance failed health check after 10 retries" }
  ```

---

### `POST /api/conversations/:id/stop`

停止 OpenCode 實例，**保留 workspace**。

**請求**：空 body

**回應**（`200 OK`）：
```json
{ "status": "stopped" }
```

**錯誤**（`409`）：
```json
{ "error": "Conversation not running" }
```

---

### `POST /api/conversations/:id/restart`

重啟 OpenCode 實例，**保留 workspace**（先 stop 再 start）。

**請求**：空 body

**回應**（`200 OK`）：
```json
{ "status": "restarting" }
```

**錯誤**（`404`）：
```json
{ "error": "Conversation not found" }
```

---

### `GET /api/conversations/:id/config`

讀取對話的 `opencode.json`。

**回應**：
```json
{
  "opencode": {
    "$schema": "https://opencode.ai/schemas/opencode.json",
    "permission": {
      "external_directory": { "*": "deny" },
      "bash": { "*": "deny" }
    },
    "model": "anthropic/claude-3-5-sonnet",
    "agent": "build"
  }
}
```

---

### `PUT /api/conversations/:id/config`

**完整覆寫**對話的 `opencode.json`。

**請求**：
```json
{
  "opencode": {
    "$schema": "https://opencode.ai/schemas/opencode.json",
    "permission": {
      "external_directory": { "*": "deny", "C:/Projects/**": "allow" },
      "bash": { "*": "deny", "git *": "allow" }
    },
    "model": "openai/gpt-5"
  }
}
```

**回應**（`204 No Content`）

---

### `GET /api/conversations/:id/agents`

列出對話的所有 Agent 定義檔。

**回應**：
```json
[
  { "name": "designer.md", "size": 256 },
  { "name": "reviewer.md", "size": 189 }
]
```

---

### `PUT /api/conversations/:id/agents`

寫入 Agent 定義檔（Markdown + YAML frontmatter）。OpenCode 會自動發現 `.opencode/agents/*.md`。

**請求**：
```json
{
  "name": "designer.md",
  "content": "---\nname: Designer\n---\nYou are a senior UI/UX designer."
}
```

**回應**（`201 Created`）

---

### `GET /api/conversations/:id/agents/:name`

讀取指定 Agent 定義檔的內容。

**回應**：
```json
{
  "name": "designer.md",
  "content": "---\nname: Designer\n---\nYou are a senior UI/UX designer."
}
```

**錯誤**（`404`）：
```json
{ "error": "Agent not found" }
```

---

### `DELETE /api/conversations/:id/agents/:name`

刪除指定 Agent 定義檔。

**回應**（`204 No Content`）

---

### `POST /api/conversations/:id/skills/upload`

上傳 Skill（以 zip 壓縮包形式）。解壓後存於 `.opencode/skills/{name}/`。

**Query**：`?name=web-search`

**Content-Type**：`application/zip`

**Body**：zip 檔案的 binary 內容

**回應**（`204 No Content`）

**錯誤**（`400`）：
```json
{ "error": "Missing name query parameter" }
```
```json
{ "error": "Invalid skill name" }
```
```json
{ "error": "Skill archive must contain SKILL.md at the root" }
```
```json
{ "error": "Invalid zip entry path: ../evil.txt" }
```

**錯誤**（`413`）：
```json
{ "error": "Skill archive exceeds workspace quota" }
```

**安全規則**：
- `name` 必須符合 `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`，否則回傳 `400 Invalid skill name`
- zip 根層級必須包含 `SKILL.md`，否則回傳 `400 Skill archive must contain SKILL.md at the root`
- 所有 zip entry 路徑經過驗證：
  - 拒絕包含 `..` 的路徑
  - 拒絕絕對路徑（以 `/` 或 `\` 開頭）
  - 拒絕 Windows 磁碟機路徑（如 `C:\...`）
  - `resolve()` 確認最終輸出路徑仍在 `destPath` 內
- 未壓縮總大小受 50 MB workspace 配額限制，超過回傳 `413`
- 上傳/匯入/刪除會標記 `needsRestart=true`（若對話處於 `running` 狀態）

---

### `POST /api/conversations/:id/skills/import`

從伺服器本地目錄複製 Skill 到對話 workspace。來源必須在 `{cwd}/skills/`、`{cwd}/assets/` 或 `{cwd}/templates/` 下。前綴相同的兄弟目錄（例如 `skills_evil/`）會被拒絕。

**請求**：
```json
{
  "source": "skills/web-search",
  "name": "web-search"
}
```

**回應**（`204 No Content`）

**錯誤**（`403`）：
```json
{ "error": "Source path not allowed. Must be under one of: /skills, /assets, /templates" }
```

**錯誤**（`404`）：
```json
{ "error": "Source not found: skills/web-search" }
```

**錯誤**（`413`）：
```json
{ "error": "Workspace quota exceeded. Current: ... bytes, Adding: ... bytes, Limit: ... bytes" }
```

---

### `GET /api/conversations/:id/skills`

列出對話的所有 Skill。

**回應**：
```json
["web-search", "code-review"]
```

---

### `GET /api/conversations/:id/skills/:name`

讀取指定 Skill 的 `SKILL.md` 內容。

**回應**：
```json
{
  "name": "web-search",
  "content": "# web-search\nA web search skill for OpenCode."
}
```

**錯誤**（`404`）：
```json
{ "error": "Skill not found" }
```

---

### `GET /api/conversations/:id/skills/:name/info`

查詢 Skill 的目錄結構、總大小與內容 hash，供客戶端驗證上傳完整性。

**回應**：
```json
{
  "name": "web-search",
  "files": ["SKILL.md", "README.md"],
  "totalSize": 1234,
  "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
}
```

---

### `DELETE /api/conversations/:id/skills/:name`

刪除指定 Skill（移除整個 `{name}/` 目錄）。

**回應**（`204 No Content`）

**錯誤**（`404`）：
```json
{ "error": "Skill not found: web-search" }
```

---

### Skill API 錯誤碼對照表

| 錯誤情境 | 狀態碼 | 回應範例 |
|----------|--------|----------|
| Missing name | 400 | `{"error": "Missing name query parameter"}` |
| Invalid skill name | 400 | `{"error": "Invalid skill name"}` |
| Invalid zip entry path | 400 | `{"error": "Invalid zip entry path: ../evil.txt"}` |
| Missing SKILL.md | 400 | `{"error": "Skill archive must contain SKILL.md at the root"}` |
| Zip parse failed | 400 | `{"error": "Invalid or unsupported zip format"}` |
| Source path not allowed | 403 | `{"error": "Source path not allowed. Must be under one of: ..."}` |
| Source not found | 404 | `{"error": "Source not found: skills/missing"}` |
| Skill not found | 404 | `{"error": "Skill not found: web-search"}` |
| Quota exceeded | 413 | `{"error": "Skill archive exceeds workspace quota"}` |
| Unexpected error | 500 | `{"error": "Internal server error"}` |

---

### Blender 多專家 Skill 部署範例

以下展示 Blender runner 使用 AgentOrchestrator 部署多專家技能的完整流程：

```
POST /api/conversations
  ↓
PUT /api/conversations/:id/agents
  ↓
POST /api/conversations/:id/skills/upload?name=extract-design-artifact
POST /api/conversations/:id/skills/upload?name=extract-spec-artifact
POST /api/conversations/:id/skills/upload?name=extract-plan-artifact
POST /api/conversations/:id/skills/upload?name=extract-validation-artifact
POST /api/conversations/:id/skills/upload?name=blender-build-actions
POST /api/conversations/:id/skills/upload?name=blender-assembly-actions
  ↓
GET /api/conversations/:id/skills/blender-build-actions/info
  ↓
POST /api/conversations/:id/start
  ↓
WS /ws/:id → message.send
```

**成功 Skill info 回應**：
```json
{
  "name": "blender-build-actions",
  "files": [
    "SKILL.md",
    "references/build_action_contract.md"
  ],
  "totalSize": 8421,
  "sha256": "a1b2c3d4e5f6..."
}
```

**Zip 結構要求**：
```
SKILL.md
references/action_schema.md
references/capabilities.md
```

**注意**：
- Skill 必須在 `prepared` 狀態時上傳，啟動後再更新需呼叫 `POST /restart` 才能生效
- `upload`/`import`/`delete` 會標記 `needsRestart=true`，但不會自動重啟 OpenCode

---

### `PUT /api/conversations/:id/files`

寫入檔案。路徑放於 request body，避免 URL 特殊字元問題。

**請求**：
```json
{
  "path": "templates/spec.md",
  "content": "# Design Spec\n\n## Goals\n..."
}
```

**回應**（`201 Created`）

**錯誤**（`400`）：
```json
{ "error": "Path contains .. or is absolute" }
```

---

### `POST /api/conversations/:id/files/read`

讀取指定檔案內容。路徑放於 request body。

**請求**：
```json
{
  "path": "templates/spec.md"
}
```

**回應**：
```json
{
  "path": "templates/spec.md",
  "content": "# Design Spec\n\n## Goals\n..."
}
```

**錯誤**（`400`）：
```json
{ "error": "Missing path in body" }
```

---

### `POST /api/conversations/:id/files/delete`

刪除指定檔案。路徑放於 request body。

**請求**：
```json
{
  "path": "templates/spec.md"
}
```

**回應**（`204 No Content`）

---

### `POST /api/conversations/:id/files/list`

列出指定目錄下的所有檔案與子目錄（僅一層，不遞迴）。路徑放於 request body，不指定 path 則列出 workspace 根目錄。

**請求**（可選 path）：
```json
{
  "path": "templates"
}
```

不帶 path（列出根目錄）：
```json
{}
```

**回應**：
```json
{
  "path": "templates",
  "files": ["spec.md", "README.md", "assets"]
}
```

---

### `GET /api/conversations/:id/sessions`

列出對話的所有會話。

**回應**：
```json
[
  {
    "id": "ses_xxx",
    "name": "default",
    "createdAt": 1717420000,
    "parent_id": null
  }
]
```

---

### `GET /api/conversations/:id/sessions/:sid/children`

取得指定會話的子會話（會話樹）。

**回應**：
```json
[
  {
    "id": "ses_child_xxx",
    "name": "fork-1",
    "createdAt": 1717420100,
    "parent_id": "ses_xxx"
  }
]
```

---

### `POST /api/conversations/:id/sessions/:sid/fork`

從指定會話建立分支（fork）。

**請求**（可選）：
```json
{
  "messageID": "msg_xxx"
}
```
- 若提供 `messageID`，分支點為該訊息；否則為會話最新狀態

**回應**（`200 OK`）：
```json
{
  "sessionId": "ses_fork_xxx"
}
```

---

### `POST /api/conversations/:id/message`

發送訊息給正在執行的對話。

**請求**：
```json
{
  "text": "Hello",
  "model": "anthropic/claude-3-5-sonnet",
  "agent": "build"
}
```
- `text`（必填）：訊息文字
- `model`（可選）：指定模型，格式為 `providerID/modelID`
- `agent`（可選）：指定 agent

**回應**（`200 OK`）：
```json
{
  "messageId": "msg_xxx",
  "text": "Hi, how can I help?",
  "parts": [
    { "type": "text", "text": "Hi, how can I help?" }
  ]
}
```

**錯誤**：
- `400`：缺少 `text`
- `409`：對話未在 `running` 狀態
  ```json
  { "error": "Conversation is not running (status: prepared)" }
  ```
- `409`：OpenCode 尚未就緒（仍在初始化中）
  ```json
  { "error": "Instance is not ready yet. OpenCode is still initializing." }
  ```
- `500`：OpenCode 實例錯誤

---

### `GET /api/conversations/:id/events`

取得對話最近 100 條事件。適用於 WebSocket 重連時的事件回放。

**回應**：
```json
[
  {
    "type": "conversation.prepared",
    "timestamp": "2026-06-05T14:45:22.734Z",
    "payload": { "id": "my-conversation-001" }
  },
  {
    "type": "conversation.starting",
    "timestamp": "2026-06-05T14:45:25.123Z",
    "payload": { "id": "my-conversation-001" }
  },
  {
    "type": "conversation.running",
    "timestamp": "2026-06-05T14:45:28.456Z",
    "payload": { "id": "my-conversation-001", "port": 30000 }
  }
]
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

**回應**（`204 No Content`）

---

### `GET /api/conversations`

列出所有活躍對話。

**回應**：
```json
[
  {
    "id": "my-conversation-001",
    "status": "running",
    "ready": false,
    "port": 30000,
    "sessionId": "ses_xxx",
    "wsUrl": "ws://127.0.0.1:11697/ws/my-conversation-001",
    "createdAt": 1780500965587,
    "updatedAt": 1780500965587
  }
]
```

---

### `GET /api/conversations/:id`

取得單一對話的詳細資訊。

**回應**：
```json
{
  "id": "my-conversation-001",
  "status": "running",
  "ready": false,
  "port": 30000,
  "sessionId": "ses_xxx",
  "wsUrl": "ws://127.0.0.1:11697/ws/my-conversation-001",
  "createdAt": 1780500965587,
  "updatedAt": 1780500965587
}
```

**錯誤**（`404`）：
```json
{ "error": "Conversation not found" }
```

---

## WebSocket API（JSON-RPC 2.0）

連線 URL：`ws://<host>:<port>/ws/<conversationId>`

所有訊息採用 JSON-RPC 2.0 格式。

**重要限制**：WebSocket 連線時若對話不存在（尚未 `POST /api/conversations`），伺服器會直接關閉連線（code `1011`）。若對話存在但狀態不是 `running`，需要執行實例的操作（如 `message.send`）會回傳 `-32001` invalid state。

---

### 會話類

#### `session.create`

建立新會話。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "session.create",
  "params": {
    "name": "feature-discussion"
  }
}
```

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "id": "ses_xxx",
    "name": "feature-discussion"
  }
}
```

---

#### `session.delete`

刪除會話。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session.delete",
  "params": {
    "id": "ses_xxx"
  }
}
```

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": { "deleted": true }
}
```

---

#### `session.list`

列出所有會話。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session.list",
  "params": {}
}
```

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": [
    { "id": "ses_xxx", "name": "default" }
  ]
}
```

---

### 訊息類

#### `message.send`

發送使用者訊息，等待 OpenCode AI 回應。OpenCode 會自動處理內建 tool calling loop（如 `read`/`edit`）。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 4,
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
  "id": 4,
  "result": {
    "messageId": "msg_xxx",
    "text": "I can help you with ...",
    "parts": [
      { "type": "text", "text": "I can help you with ..." }
    ]
  }
}
```

**錯誤**（`-32001` invalid state）：
```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "error": { "code": -32001, "message": "Conversation not running" }
}
```

**錯誤**（`-32000` server error，OpenCode 尚未就緒）：
```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "error": { "code": -32000, "message": "Instance not ready yet" }
}
```

---

#### `message.history`

取得對話歷史。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "message.history",
  "params": { "limit": 10 }
}
```

**回應**：陣列，包含完整訊息結構（含 `info` 與 `parts`）。

---

### 對話控制類

#### `conversation.status`

取得對話當前狀態。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "conversation.status",
  "params": {}
}
```

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "result": {
    "id": "my-conversation-001",
    "status": "running",
    "port": 30000,
    "sessionId": "ses_xxx"
  }
}
```

---

#### `conversation.start`

透過 WebSocket 請求啟動對話（等同 `POST /start`）。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "conversation.start",
  "params": {}
}
```

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "result": { "status": "running" }
}
```

---

#### `conversation.stop`

透過 WebSocket 請求停止對話（等同 `POST /stop`）。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 8,
  "method": "conversation.stop",
  "params": {}
}
```

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 8,
  "result": { "status": "stopped" }
}
```

---

#### `conversation.restart`

透過 WebSocket 請求重啟對話（等同 `POST /restart`）。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 9,
  "method": "conversation.restart",
  "params": {}
}
```

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 9,
  "result": { "status": "restarting" }
}
```

---

### 配置類

#### `config.read`

讀取 `opencode.json`。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "method": "config.read",
  "params": {}
}
```

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "result": {
    "config": {
      "$schema": "https://opencode.ai/schemas/opencode.json",
      "permission": { "external_directory": { "*": "deny" }, "bash": { "*": "deny" } }
    }
  }
}
```

---

#### `config.write`

覆寫 `opencode.json`。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 11,
  "method": "config.write",
  "params": {
    "opencode": {
      "$schema": "https://opencode.ai/schemas/opencode.json",
      "permission": { "external_directory": { "*": "deny" }, "bash": { "*": "deny" } },
      "model": "openai/gpt-5"
    }
  }
}
```

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 11,
  "result": { "ok": true }
}
```

---

### Agent 類

#### `agent.list`

列出所有 Agent。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 12,
  "method": "agent.list",
  "params": {}
}
```

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 12,
  "result": [
    { "name": "designer.md", "size": 256 }
  ]
}
```

---

#### `agent.read`

讀取指定 Agent。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 13,
  "method": "agent.read",
  "params": {
    "name": "designer.md"
  }
}
```

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 13,
  "result": {
    "name": "designer.md",
    "content": "---\nname: Designer\n---\nYou are a senior UI/UX designer."
  }
}
```

---

#### `agent.write`

寫入 Agent。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 14,
  "method": "agent.write",
  "params": {
    "name": "designer.md",
    "content": "---\nname: Designer\n---\nYou are a senior UI/UX designer."
  }
}
```

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 14,
  "result": { "ok": true }
}
```

---

#### `agent.delete`

刪除指定 Agent。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 15,
  "method": "agent.delete",
  "params": {
    "name": "designer.md"
  }
}
```

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 15,
  "result": { "ok": true }
}
```

---

### Skill 類

#### `skills.import`

從伺服器本地目錄導入 Skill。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 15,
  "method": "skills.import",
  "params": {
    "source": "skills/web-search",
    "name": "web-search"
  }
}
```

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 15,
  "result": { "imported": "web-search" }
}
```

---

#### `skills.list`

列出所有 Skill。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 16,
  "method": "skills.list",
  "params": {}
}
```

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 16,
  "result": ["web-search", "code-review"]
}
```

---

#### `skills.get`

讀取指定 Skill 的 `SKILL.md` 內容。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 17,
  "method": "skills.get",
  "params": {
    "name": "web-search"
  }
}
```

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 17,
  "result": "# web-search\nA web search skill for OpenCode."
}
```

---

#### `skills.info`

查詢 Skill 結構與 hash。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 18,
  "method": "skills.info",
  "params": {
    "name": "web-search"
  }
}
```

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 18,
  "result": {
    "name": "web-search",
    "files": ["SKILL.md"],
    "totalSize": 1234,
    "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  }
}
```

---

#### `skills.delete`

刪除指定 Skill。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 19,
  "method": "skills.delete",
  "params": {
    "name": "web-search"
  }
}
```

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 19,
  "result": { "deleted": "web-search" }
}
```

---

### 檔案類

#### `file.list`

列出所有檔案。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 16,
  "method": "file.list",
  "params": {}
}
```

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 16,
  "result": [
    { "path": "templates/spec.md", "size": 1024 }
  ]
}
```

---

#### `file.read`

讀取指定檔案。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 17,
  "method": "file.read",
  "params": {
    "path": "templates/spec.md"
  }
}
```

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 17,
  "result": {
    "path": "templates/spec.md",
    "content": "# Design Spec\n\n## Goals\n..."
  }
}
```

---

#### `file.write`

寫入檔案。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 18,
  "method": "file.write",
  "params": {
    "path": "templates/spec.md",
    "content": "# Design Spec\n\n## Goals\n..."
  }
}
```

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 18,
  "result": { "ok": true }
}
```

---

#### `file.delete`

刪除指定檔案。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 19,
  "method": "file.delete",
  "params": {
    "path": "templates/spec.md"
  }
}
```

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 19,
  "result": { "ok": true }
}
```

---

### 事件類

#### `events.subscribe`

訂閱對話事件流。訂閱後，伺服器會透過 WebSocket 主動推送 `conversation.*` 事件。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 20,
  "method": "events.subscribe",
  "params": {}
}
```

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 20,
  "result": { "subscribed": true }
}
```

訂閱後可能收到的事件推送：
```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "type": "conversation.running",
    "timestamp": "2026-06-05T14:45:28.456Z",
    "payload": { "id": "demo", "port": 30000 }
  }
}
```

---

#### `events.unsubscribe`

取消訂閱事件流。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 21,
  "method": "events.unsubscribe",
  "params": {}
}
```

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 21,
  "result": { "subscribed": false }
}
```

---

## Conversation 生命周期事件

當對話狀態改變時，AgentOrchestrator 會透過 WebSocket 推送事件（需先 `events.subscribe`）。

| 事件類型 | 觸發時機 | Payload |
|----------|----------|---------|
| `conversation.prepared` | `POST /api/conversations` 完成 | `{ id }` |
| `conversation.starting` | `POST /start` 開始 spawn | `{ id }` |
| `conversation.running` | OpenCode 健康檢查通過 | `{ id, port }` |
| `conversation.ready` | OpenCode Session 首次可查詢（ready poll 成功） | `{ id }` |
| `conversation.readyLost` | OpenCode Session 失聯（ready keepalive 失敗） | `{ id }` |
| `conversation.stopped` | `POST /stop` 完成 | `{ id }` |
| `conversation.restarting` | `POST /restart` 開始 | `{ id }` |
| `conversation.destroyed` | `DELETE /:id` 完成 | `{ id }` |

**使用範例**：前端可在收到 `conversation.ready` 後才啟用聊天輸入框，確保 OpenCode 已完全就緒。

---

## Agent 自動發現機制

AgentOrchestrator 不直接管理 OpenCode 內部的 Agent 列表，而是透過**檔案系統約定**實現自動發現：

1. 呼叫 `PUT /api/conversations/:id/agents` 時，AgentOrchestrator 將 Markdown 檔案寫入 `{workspace}/.opencode/agents/{name}.md`
2. OpenCode 啟動時會自動掃描 `.opencode/agents/*.md`，讀取 YAML frontmatter 作為 Agent 定義
3. 無需修改 `opencode.json` 或透過 HTTP API 註冊 Agent

**Agent Markdown 格式**：
```markdown
---
name: Designer
description: A senior UI/UX designer for web applications
---

You are a senior UI/UX designer. Your responsibilities include:
- Creating wireframes and mockups
- Reviewing design consistency
```

---

## 檔案操作安全限制與路徑參數規範

### 為什麼路徑放在 body / query 而非 URL path？

所有檔案與 Agent 操作的路徑參數統一放於 **request body**（`PUT`）或 **query string**（`GET` / `DELETE`），而非 URL path segment。原因如下：

1. **避免 URL 特殊字元編碼問題**：檔案名可能包含空格、`#`、`%` 等字元，放在 body 無需擔心 URL encoding
2. **防止 URL routing 層的路徑遍歷**：某些 web framework 可能將 URL path `../../../etc/passwd` 誤解析為合法路由；將路徑移至 body 可由應用層統一驗證
3. **集中驗證**：所有路徑都通過 `sanitizeRelativePath()` 檢查，規則一致

### `sanitizeRelativePath()` 規則

- 拒絕包含 `..` 的相對路徑
- 拒絕絕對路徑（以 `/` 或 Windows 磁碟機代號 `[A-Z]:` 開頭）
- 允許純相對路徑如 `templates/spec.md`、`assets/logo.png`

### 安全限制

| 限制項目 | 說明 |
|----------|------|
| HTTP body limit | `express.json({ limit: '10mb' })` + `express.text({ limit: '5mb' })` |
| Workspace 配額 | 上限 50 MB（`MAX_WORKSPACE_SIZE = 50 * 1024 * 1024` bytes），超過時寫入操作被拒絕 |
| `copyFromLocal` 白名單 | 僅允許來源路徑在 `{cwd}/assets/`、`{cwd}/templates/` 或 `{cwd}/skills/` 下 |
| Skill 名稱驗證 | `validateSkillName()` 只允許 `[A-Za-z0-9_-]`，最大長度 128 |
| Zip Slip 防護 | `skills/upload` 逐條驗證 zip entry 路徑，確認 `resolve()` 後仍在 `destPath` 內 |
| Skill 結構驗證 | `skills/upload` 要求 zip 根層級必須包含 `SKILL.md` |
| 未壓縮大小檢查 | `skills/upload` 計算 `sum(entry.header.size)` 並調用 `assertQuota`，防止 zip bomb |

---

## 錯誤處理

### REST HTTP 錯誤

| 狀態碼 | 說明 |
|--------|------|
| `200` | OK |
| `201` | Created |
| `204` | No Content |
| `400` | Bad Request（路徑遍歷、配額超過、缺少 body field、無效 skill 名稱、zip 結構錯誤） |
| `403` | Forbidden（本地複製來源不在白名單） |
| `404` | Not Found（對話、Agent、檔案、Skill 不存在） |
| `409` | Conflict（已運行 / 未運行 / 已存在） |
| `413` | Payload Too Large（Skill 壓縮包未壓縮大小超過 50 MB 配額） |
| `500` | Server Error |

**REST 錯誤回應格式**：
```json
{ "error": "錯誤訊息" }
```

### WebSocket JSON-RPC 錯誤

| 錯誤碼 | 說明 |
|--------|------|
| `-32700` | Parse error：無法解析 JSON |
| `-32600` | Invalid Request：jsonrpc 版本不對或缺少 method |
| `-32601` | Method not found：未知的 WebSocket method |
| `-32000` | Server error：一般伺服器錯誤 |
| `-32001` | Invalid state：對話狀態不允許此操作（如未運行時呼叫 `message.send`） |

**WebSocket JSON-RPC 錯誤回應格式**：
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": { "code": -32001, "message": "Conversation not running" }
}
```
