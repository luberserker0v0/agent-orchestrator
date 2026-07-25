> **DEPRECATED**: This file has been reorganized. See [new documentation](api/) for the updated API reference. This file will be removed in a future version.

# API 文件

AgentOrchestrator 提供 REST API 與 WebSocket API（JSON-RPC 2.0）兩種介面。

> **認證說明**：若伺服器設定了 `server.apiKeys`（設定檔），所有請求（除 `/health`、`/metrics`、`/api-docs*`、`/dashboard*` 外）需要在 HTTP 標頭中包含 `Authorization: Bearer <apiKey>`。
>
> **角色權限**：`apiKeys` 中每個 key 有 `role` 欄位（`admin`、`user` 或 `observer`）。Admin 擁有完整操作權限包括角色管理；User 可操作對話（建立/啟動/停止/重啟）、發送訊息、管理檔案/Session/Skill；Observer 只能進行 GET 讀取操作。向後兼容：若只設定 `server.apiKey`（字串），等同 admin 角色。
>
> **權限模型**：角色透過 `server.roles` 定義，每個角色包含 `permissions` 陣列，格式為 `resource:action`（如 `conversation:start`、`message:send`、`role:write`）。Admin 角色使用 `["*"]` 表示全部權限。角色可透過 REST API 動態新增/修改/刪除，變更會持久化到設定檔。
>
> **WebSocket 認證**：WS 連接需在 URL query string 中帶入 `apiKey` 參數（例如 `ws://host/ws/conv-001?apiKey=xxx`），或在 HTTP 升級請求中帶入 `x-api-key` 標頭。User 和 Observer 角色的連線根據權限限制可執行的 WS 方法。

---

## Dashboard

內建 SPA 管理介面，提供對話觀察和即時事件監控。

### `GET /dashboard`

開啟 Dashboard 介面（不需要預先認證，SPA 內部處理登入流程）。

- **登入**：輸入 API key，SPA 驗證後存入 sessionStorage
- **對話列表**：顯示所有 conversation 的狀態、端口、Agent 類型、年齡
- **對話詳情**：左側事件時間線 + 右側訊息歷史，WS 即時更新
- **角色感知**：Observer 看不到操作按鈕，Admin 可停止/重啟/刪除

### `GET /api/auth/role`

回傳當前 API key 的角色資訊（供 Dashboard 使用）。

**回應**：
```json
{ "role": "admin", "name": "Admin" }
```
---

### 角色管理 API（RBAC）

以下端點用於動態管理角色定義。角色變更會即時生效並持久化到設定檔。

#### `GET /api/roles`

列出所有已定義的角色及其權限。

**權限**：所有已認證使用者

**回應**（`200 OK`）：
```json
{
  "roles": {
    "admin": {
      "permissions": ["*"]
    },
    "user": {
      "permissions": [
        "conversation:create", "conversation:start", "conversation:stop",
        "conversation:restart", "conversation:read", "conversation:list",
        "message:send", "message:read",
        "config:read", "config:write",
        "agent:read", "file:read", "file:write", "file:delete",
        "session:read", "session:create", "session:delete",
        "skill:read", "skill:import", "skill:delete"
      ]
    },
    "observer": {
      "permissions": [
        "conversation:read", "conversation:list",
        "message:read",
        "config:read",
        "agent:read",
        "session:read",
        "skill:read"
      ]
    }
  }
}
```

---

#### `POST /api/roles`

新增角色。已有同名角色會回傳 409。

**權限**：admin

**請求**：
```json
{
  "name": "moderator",
  "permissions": [
    "conversation:read", "conversation:list",
    "conversation:start", "conversation:stop",
    "message:read", "message:send",
    "agent:read"
  ]
}
```

- `name`（必填）：角色名稱，只允許 `[A-Za-z0-9_-]`，最大 32 字元
- `permissions`（必填）：權限陣列，格式為 `resource:action`

**回應**（`201 Created`）：
```json
{
  "name": "moderator",
  "permissions": [
    "conversation:read", "conversation:list",
    "conversation:start", "conversation:stop",
    "message:read", "message:send",
    "agent:read"
  ]
}
```

**錯誤**：
- `400`：名稱格式無效或缺少欄位
  ```json
  { "error": { "code": "INVALID_ROLE_NAME", "message": "Role name must match [A-Za-z0-9_-]{1,32}" } }
  ```
- `409`：角色已存在
  ```json
  { "error": { "code": "ROLE_ALREADY_EXISTS", "message": "Role 'moderator' already exists" } }
  ```

---

#### `PUT /api/roles/:name`

更新角色權限。角色名稱不可變更（如需改名，請刪除後重建）。

**權限**：admin

**請求**：
```json
{
  "permissions": [
    "conversation:read", "conversation:list",
    "message:read"
  ]
}
```

**回應**（`200 OK`）：
```json
{
  "name": "moderator",
  "permissions": [
    "conversation:read", "conversation:list",
    "message:read"
  ]
}
```

**錯誤**：
- `404`：角色不存在
  ```json
  { "error": { "code": "ROLE_NOT_FOUND", "message": "Role 'moderator' not found" } }
  ```
- `400`：嘗試修改 `admin` 角色的 `*` 權限
  ```json
  { "error": { "code": "CANNOT_MODIFY_ADMIN", "message": "Cannot modify admin role permissions" } }
  ```

---

#### `DELETE /api/roles/:name`

刪除角色。不可刪除 `admin` 角色。

**權限**：admin

**回應**（`204 No Content`）

**錯誤**：
- `404`：角色不存在
- `400`：嘗試刪除 admin 角色
  ```json
  { "error": { "code": "CANNOT_DELETE_ADMIN", "message": "Cannot delete admin role" } }
  ```

---

### 權限模型

每個角色包含 `permissions` 陣列，格式為 `resource:action`：

| Resource | Actions | 說明 |
|----------|---------|------|
| `conversation` | `create`, `start`, `stop`, `restart`, `read`, `list`, `delete` | 對話生命週期管理 |
| `message` | `send`, `read` | 訊息發送與讀取 |
| `config` | `read`, `write` | opencode.json 讀寫 |
| `agent` | `read`, `write`, `delete` | Agent 定義管理 |
| `file` | `read`, `write`, `delete`, `copy` | Workspace 檔案操作 |
| `session` | `read`, `create`, `delete` | OpenCode Session 管理 |
| `skill` | `read`, `import`, `delete` | Skill 管理 |
| `role` | `read`, `write` | 角色管理（僅 admin） |

Admin 角色使用 `["*"]` 表示全部權限。其他角色需明確列出所需權限。

**預設角色權限**：
- **admin**：`["*"]`（全部權限，包括角色管理）
- **user**：對話操作 + 訊息發送 + 設定/檔案/Session/Skill 讀寫
- **observer**：僅讀取（列出/檢視對話、訊息、設定、Agent、Session、Skill）

---

## REST API

### `GET /api-docs/`

Swagger UI 互動式 API 瀏覽器。以 HTML 頁面呈現完整的 REST API 文件，可直接在瀏覽器中測試端點。

**回應**（`text/html`）：Swagger UI 頁面

---

### `GET /api-docs`

重新導向至 `/api-docs/`。

**回應**：`301 Moved Permanently`
- `Location: /api-docs/`

---

### `GET /api-docs.json`

OpenAPI 3.0 規格原始 JSON，可用於匯入 Postman、Insomnia 等 API 工具。

**回應**（`application/json`）：完整的 OpenAPI 3.0.3 規格文件，包含所有 REST 端點定義、請求/回應結構、錯誤碼。

---

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
| `agentorchestrator_instances_errors_total` | Counter | 實例錯誤數（labels: type: spawn|health|kill） |
| `agentorchestrator_instance_spawn_duration_seconds` | Histogram | 啟動 OpenCode 實例耗時 |
| `agentorchestrator_port_pool_available` | Gauge | 動態端口池中可用端口數 |
| `agentorchestrator_websocket_connections_active` | Gauge | 活躍的 WebSocket 連線數 |
| `agentorchestrator_http_requests_total` | Counter | 總 HTTP 請求數（labels: method, status） |
| `agentorchestrator_http_request_duration_seconds` | Histogram | HTTP 請求持續時間（labels: method, status） |
| `agentorchestrator_conversation_state_changes_total` | Counter | 對話狀態轉換數（labels: status） |
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
- **注意**：`model` 與 `agent` 不再作為請求欄位；請透過 config endpoints（`POST /:id/config` 或 WS `config.update`）設定 opencode.json

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
  "id": "my-conversation-001",
  "status": "running",
  "ready": false,
  "port": 30000,
  "wsUrl": "ws://127.0.0.1:11697/ws/my-conversation-001",
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

停止 OpenCode 實例，**移除 workspace**（可透過 `POST /start` 重新建立並啟動）。

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
{
  "id": "my-conversation-001",
  "status": "running",
  "ready": false,
  "port": 30000,
  "wsUrl": "ws://127.0.0.1:11697/ws/my-conversation-001",
  "sessionId": "ses_xxx"
}
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

### `POST /api/conversations/:id/config`

寫入（或更新）對話的 `opencode.json`。

當 `enforceCanonicalConfig=true`（預設），伺服器會先從 `config/canonical-opencode.example.json` 載入系統預設值，再合併使用者提供的 keys（使用者 keys 僅在 canonical 中不存在的項目才會生效，保護 `$schema` 與 `permission` 不被覆寫）。若設為 `false`，則直接寫入使用者的原始內容。

**請求**：
```json
{
  "$schema": "https://opencode.ai/schemas/opencode.json",
  "permission": {
    "external_directory": { "*": "deny", "C:/Projects/**": "allow" },
    "bash": { "*": "deny", "git *": "allow" }
  },
  "model": "openai/gpt-5"
}
```

**回應**（`204 No Content`）

---

### `PATCH /api/conversations/:id/config`

部分更新對話的 `opencode.json`。僅更新請求中提供的欄位，其他欄位保持不變。

**請求**：
```json
{
  "model": "openai/gpt-5"
}
```

**回應**（`204 No Content`）

---

### `GET /api/conversations/:id/agents`

列出對話的所有 Agent 定義檔。

當 OpenCode 實例正在運行且就緒時，回傳包含名稱與描述的增強資料；否則回傳純名稱陣列。

**回應**（實例運行中）：
```json
[
  { "name": "designer.md", "description": "A senior UI/UX designer" },
  { "name": "reviewer.md", "description": "A code reviewer" }
]
```

**回應**（實例未運行）：
```json
["designer.md", "reviewer.md"]
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

**回應**（`204 No Content`）

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

### `PUT /api/conversations/:id/agent/config`

寫入 AGENTS.md 內容。

**請求**：
```json
{
  "content": "# Project Agents\n\n## Designer\n..."
}
```

**回應**（`204 No Content`）

---

### `GET /api/conversations/:id/agent/config`

讀取 AGENTS.md 內容。

**回應**：
```json
{
  "content": "# Project Agents\n\n## Designer\n..."
}
```

**錯誤**（`404`）：
```json
{ "error": "AGENTS.md not found" }
```

---

### `DELETE /api/conversations/:id/agent/config`

刪除 AGENTS.md。

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

### Agent-Scoped Skill API

以下端點與上方共用相同邏輯，但 Skill 儲存在 `.opencode/agents/{agent}/skills/{name}/` 路徑下，實現 subagent 技能隔離。所有端點多一個 `{agent}` 路徑參數，需符合 `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`，否則回傳 `400 Invalid agent name`。

#### `POST /api/conversations/:id/agents/:agent/skills/upload`

上傳 Skill 到指定 Agent（zip 壓縮包形式）。

**Query**：`?name=web-search`

**Content-Type**：`application/zip`

**Body**：zip 檔案的 binary 內容

**回應**（`204 No Content`）

---

#### `POST /api/conversations/:id/agents/:agent/skills/import`

從伺服器本地目錄複製 Skill 到指定 Agent 的 workspace。

**請求**：
```json
{
  "source": "skills/web-search",
  "name": "web-search"
}
```

**回應**（`204 No Content`）

---

#### `GET /api/conversations/:id/agents/:agent/skills`

列出指定 Agent 的所有 Skill。

**回應**：
```json
["web-search", "code-review"]
```

---

#### `GET /api/conversations/:id/agents/:agent/skills/:name`

讀取指定 Agent Skill 的 `SKILL.md` 內容。

**回應**：
```json
{
  "name": "web-search",
  "content": "# web-search\nA web search skill for OpenCode."
}
```

---

#### `GET /api/conversations/:id/agents/:agent/skills/:name/info`

查詢指定 Agent Skill 的目錄結構、總大小與內容 hash。

**回應**：
```json
{
  "name": "web-search",
  "files": ["SKILL.md"],
  "totalSize": 1234,
  "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
}
```

---

#### `DELETE /api/conversations/:id/agents/:agent/skills/:name`

刪除指定 Agent Skill（移除整個 `{name}/` 目錄）。

**回應**（`204 No Content`）

---

### Skill API 錯誤碼對照表

| 錯誤情境 | 狀態碼 | 回應範例 |
|----------|--------|----------|
| Missing name | 400 | `{"error": "Missing name query parameter"}` |
| Invalid skill name | 400 | `{"error": "Invalid skill name"}` |
| Invalid agent name | 400 | `{"error": "Invalid agent name"}` |
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

**回應**（`204 No Content`）

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

### `POST /api/conversations/:id/sessions`

建立新會話（僅在對話為 `running` 且 `ready` 狀態時可用）。

**請求**：
```json
{
  "title": "feature-discussion",
  "parentID": "ses_parent_xxx"
}
```
- `title`（可選）：會話標題
- `parentID`（可選）：父會話 ID（從指定會話分支建立）

**回應**（`201 Created`）：OpenCode 會話物件。

**錯誤**（`409`）：
```json
{ "error": "Instance is not ready yet. OpenCode is still initializing." }
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

### `GET /api/conversations/:id/sessions/:sid/messages`

取得指定會話的訊息歷史（包括子代理會話的內容）。

**查詢參數**：
| 參數 | 類型 | 必填 | 說明 |
|------|------|------|------|
| `limit` | integer | 否 | 限制回傳的訊息數量 |

**回應**：陣列，包含完整訊息結構（含 `info` 與 `parts`）。

```json
[
  {
    "info": { "id": "msg_1", "role": "user" },
    "parts": [{ "type": "text", "text": "Hello" }]
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

取得對話最近 50 條事件（可透過 `?limit=100` 取得最多 100 條）。適用於 WebSocket 重連時的事件回放。

**回應**：
```json
[
  {
    "type": "conversation.prepared",
    "id": "my-conversation-001",
    "timestamp": 1780500965587,
    "payload": {}
  },
  {
    "type": "conversation.starting",
    "id": "my-conversation-001",
    "timestamp": 1780500967123,
    "payload": {}
  },
  {
    "type": "conversation.running",
    "id": "my-conversation-001",
    "timestamp": 1780500968456,
    "payload": { "status": "running" }
  }
]
```

### `GET /api/conversations/:id/providers`

取得執行中 OpenCode 實例的供應商列表。代理至實例的 provider 端點。

**注意**：對話必須處於 `running` 且 `ready` 狀態。

**回應**：
```json
[
  { "id": "anthropic", "name": "Anthropic", "models": ["claude-3-5-sonnet"] }
]
```

**錯誤**（`409`）：
```json
{ "error": "Instance is not ready yet. OpenCode is still initializing." }
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

連線 URL：`ws://<host>:<port>/ws/<conversationId>?apiKey=<key>`

> **認證**：若伺服器設定了 `apiKeys`，WebSocket 升級時需帶入 `apiKey` query 參數或 `x-api-key` 標頭。根據角色權限限制可執行的 WS 方法：Admin 可執行全部方法；User 可執行對話操作、訊息、檔案、Session、Skill 相關方法；Observer 只能執行唯讀方法（如 `message.history`、`conversation.status`）。

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
    "title": "feature-discussion",
    "parentID": "ses_parent_xxx"
  }
}
```
- `title`（可選）：會話標題
- `parentID`（可選）：父會話 ID（從指定會話分支建立）

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "id": "ses_xxx",
    "title": "feature-discussion"
  }
}
```

---

#### `session.get`

取得指定會話詳細資訊。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session.get",
  "params": {
    "sessionId": "ses_xxx"
  }
}
```

**回應**：OpenCode 會話物件。

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

#### `session.children`

取得指定會話的子會話。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "session.children",
  "params": {
    "sessionId": "ses_xxx"
  }
}
```

**回應**：子會話陣列。

---

#### `session.fork`

從指定會話建立分支。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "session.fork",
  "params": {
    "sessionId": "ses_xxx",
    "messageID": "msg_xxx"
  }
}
```
- `sessionId`（必填）：來源會話
- `messageID`（可選）：分支點訊息 ID，省略則以最新狀態分支

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "sessionId": "ses_fork_xxx"
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
  "id": 6,
  "method": "session.delete",
  "params": {
    "sessionId": "ses_xxx"
  }
}
```

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "result": { "deleted": "ses_xxx" }
}
```

---

#### `session.abort`

中止正在生成的回應。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "session.abort",
  "params": {}
}
```

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "result": { "aborted": true }
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

取得對話歷史。可指定 `sessionId` 以查詢子代理會話的訊息（需先用 `GET /sessions/:sid/children` 或 `conversation.session.children` 取得會話 ID）。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "message.history",
  "params": { "limit": 10 }
}
```

可選參數 `sessionId`：

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "message.history",
  "params": { "sessionId": "child_ses_xxx", "limit": 10 }
}
```

**回應**：陣列，包含完整訊息結構（含 `info` 與 `parts`）。

**參數**：
| 參數 | 類型 | 必填 | 說明 |
|------|------|------|------|
| `sessionId` | string | 否 | 要查詢的會話 ID；省略時使用主會話 |
| `limit` | integer | 否 | 限制回傳的訊息數量 |

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
    "ready": false,
    "port": 30000,
    "sessionId": "ses_xxx",
    "wsUrl": "ws://127.0.0.1:11697/ws/my-conversation-001"
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
  "result": {
    "status": "running",
    "port": 30000,
    "wsUrl": "ws://127.0.0.1:11697/ws/my-conversation-001",
    "sessionId": "ses_xxx"
  }
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
  "result": {
    "status": "running",
    "port": 30000,
    "wsUrl": "ws://127.0.0.1:11697/ws/my-conversation-001",
    "sessionId": "ses_xxx"
  }
```

---

### 配置類

#### `config.get`

讀取 `opencode.json`。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "method": "config.get",
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

#### `config.update`

寫入（或更新）`opencode.json`。當 `enforceCanonicalConfig=true`（預設），僅接受 canonical 中不存在的使用者 keys，保護系統預設值不被覆寫。可透過 `workspace.enforceCanonicalConfig=false` 關閉此行為。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 11,
  "method": "config.update",
  "params": {
    "$schema": "https://opencode.ai/schemas/opencode.json",
    "permission": { "external_directory": { "*": "deny" }, "bash": { "*": "deny" } },
    "model": "openai/gpt-5"
  }
}
```

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 11,
  "result": { "updated": true }
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

#### `agent.get`

讀取指定 Agent。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 13,
  "method": "agent.get",
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

#### `agent.register`

寫入 Agent。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 14,
  "method": "agent.register",
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
  "result": { "registered": "designer.md" }
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
  "result": { "deleted": "designer.md" }
}
```

---

### AGENTS.md 類

#### `agent.config.write`

寫入 AGENTS.md 內容。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 16,
  "method": "agent.config.write",
  "params": {
    "content": "# Project Agents\n\n## Designer\n..."
  }
}
```

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 16,
  "result": { "written": true }
}
```

---

#### `agent.config.get`

讀取 AGENTS.md 內容。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 17,
  "method": "agent.config.get",
  "params": {}
}
```

**回應**：AGENTS.md 文字內容。

---

#### `agent.config.delete`

刪除 AGENTS.md。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 18,
  "method": "agent.config.delete",
  "params": {}
}
```

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 18,
  "result": { "deleted": true }
}
```

---

### Skill 類

所有 Skill WebSocket 方法均支援可選的 `agent` 參數。提供 `agent` 時，操作針對 `.opencode/agents/{agent}/skills/` 路徑下的技能；省略時則操作共用的 `.opencode/skills/` 路徑。

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
    "name": "web-search",
    "agent": "my-agent"
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

#### `file.copy`

從伺服器本機 `{cwd}/assets/`、`{cwd}/templates/` 或 `{cwd}/skills/` 路徑複製檔案/資料夾到 workspace。

**請求**：
```json
{
  "jsonrpc": "2.0",
  "id": 18,
  "method": "file.copy",
  "params": {
    "source": "templates/spec.md",
    "dest": "docs/spec.md"
  }
}
```

**回應**：
```json
{
  "jsonrpc": "2.0",
  "id": 18,
  "result": { "copied": "docs/spec.md" }
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

#### 事件推送（自動行為）

WebSocket 連線建立後即自動訂閱事件流，無需顯式 RPC 方法。伺服器透過 JSON-RPC notification 推送事件：

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "type": "conversation.running",
    "timestamp": 1780500968456,
    "payload": { "id": "demo" }
  }
}
```

---

## Conversation 生命周期事件

當對話狀態改變時，AgentOrchestrator 會自動透過 WebSocket 推送事件（連線建立後自動訂閱，無需顯式呼叫）。

| 事件類型 | 觸發時機 | Payload |
|----------|----------|---------|
| `conversation.prepared` | `POST /api/conversations` 完成 | `{ id }` |
| `conversation.starting` | `POST /start` 開始 spawn | `{ id }` |
| `conversation.running` | OpenCode 健康檢查通過 | `{ id }` |
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

**REST 錯誤回應格式**（v2 — 結構化錯誤）：
```json
{ "error": { "code": "ERROR_CODE", "message": "錯誤訊息" } }
```

**常見錯誤碼**：

| 錯誤碼 | HTTP 狀態 | 說明 |
|--------|-----------|------|
| `CONVERSATION_NOT_FOUND` | 404 | 指定的對話不存在 |
| `CONVERSATION_ALREADY_EXISTS` | 409 | 對話已存在（建立時） |
| `CONVERSATION_ALREADY_RUNNING` | 409 | 對話已在運行中（啟動時） |
| `CONVERSATION_NOT_RUNNING` | 409 | 對話未在運行狀態 |
| `CANNOT_STOP` | 409 | 當前狀態不允許停止 |
| `CANNOT_RESTART` | 409 | 當前狀態不允許重啟 |
| `UNKNOWN_AGENT_TYPE` | 400 | 指定的 agent type 未註冊 |
| `MISSING_FIELD` | 400 | 缺少必要欄位 |
| `INVALID_REQUEST_BODY` | 400 | Request body 格式不正確 |
| `INVALID_SKILL_NAME` | 400 | Skill 名稱格式無效 |
| `INSTANCE_NOT_READY` | 409 | OpenCode 實例尚未就緒 |
| `INSTANCE_REFERENCE_LOST` | 500 | 內部實例引用遺失 |
| `SESSION_NOT_READY` | 503 | Session 尚未就緒 |
| `PATH_TRAVERSAL` | 400 | 路徑穿越攻擊偵測 |
| `INVALID_PATH` | 400 | 無效的路徑 |
| `SKILL_INVALID_ARCHIVE` | 400 | Skill 壓縮包結構錯誤 |
| `SKILL_QUOTA_EXCEEDED` | 413 | Skill 超過配額 |
| `SOURCE_NOT_ALLOWED` | 403 | 複製來源不允許 |
| `SOURCE_NOT_FOUND` | 404 | 複製來源不存在 |
| `SKILL_NOT_FOUND` | 404 | Skill 不存在 |
| `FILE_NOT_FOUND` | 404 | 檔案不存在 |
| `AGENT_NOT_FOUND` | 404 | Agent 不存在 |
| `WORKSPACE_QUOTA_EXCEEDED` | 413 | Workspace 配額超額 |
| `INVALID_TEXT` | 400 | 無效的 text 欄位 |
| `UNAUTHORIZED` | 401 | 缺少或無效的 API key |
| `FORBIDDEN` | 403 | 權限不足（角色無此操作權限） |
| `INVALID_ROLE_NAME` | 400 | 角色名稱格式無效 |
| `ROLE_NOT_FOUND` | 404 | 角色不存在 |
| `ROLE_ALREADY_EXISTS` | 409 | 角色已存在 |
| `CANNOT_MODIFY_ADMIN` | 400 | 不可修改 admin 角色權限 |
| `CANNOT_DELETE_ADMIN` | 400 | 不可刪除 admin 角色 |
| `INTERNAL_ERROR` | 500 | 內部伺服器錯誤（未預期） |

### WebSocket JSON-RPC 錯誤

| 錯誤碼 | 說明 |
|--------|------|
| `-32700` | Parse error：無法解析 JSON |
| `-32600` | Invalid Request：jsonrpc 版本不對或缺少 method |
| `-32000` | Server error：所有應用層錯誤（含狀態錯誤、缺少參數、內部錯誤） |

所有應用層錯誤（validation、state、internal）統一使用 `-32000`，並在 `data.code` 中提供結構化錯誤碼：

**WebSocket JSON-RPC 錯誤回應格式**：
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32000,
    "message": "Conversation not running (status: stopped)",
    "data": { "code": "CONVERSATION_NOT_RUNNING" }
  }
}
```

`data.code` 的值與 REST HTTP 錯誤碼共用同一組常數（見上方表格）。
