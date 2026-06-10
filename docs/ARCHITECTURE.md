# 架構說明

## 概覽

AgentOrchestrator 是一個 Node.js 長期執行服務，作為 OpenCode 實例的編排器（Orchestrator），為每個對話（Conversation）動態建立獨立的 `opencode serve` 進程，並透過 HTTP REST API 與 WebSocket 提供統一的外部介面。

與舊版直接「建立即啟動」不同，新版採用**延遲啟動（Delayed-Start）**設計：先準備 workspace（`prepared`），再由用戶端決定何時啟動 OpenCode（`starting` → `running`），允許在啟動前預先寫入 Agent 定義、模板檔案與對話配置。

```
┌─────────────────────────────────────────────────────────────┐
│                         Client / Frontend                    │
│  (curl, WebSocket Client, Browser, Mobile App...)            │
└──────────────────────────────┬──────────────────────────────┘
                                │
            ┌───────────────────┼───────────────────┐
            │                   │                   │
            │  HTTP POST        │  HTTP GET         │  WS /ws/{id}
            │  /api/conversations│  /api/models     │
            ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────────────┐
│                    AgentOrchestrator HTTP API                │
│  • Express Server (port 0 = auto-allocated)                 │
│  • WebSocket upgrade handling                               │
│  • JSON-RPC 2.0 dispatch                                    │
│  • ConversationState (event-driven lifecycle)               │
└──────────────────────────────┬──────────────────────────────┘
                                │
            ┌───────────────────┼───────────────────┐
            │                   │                   │
            │ spawn(...)        │ spawn("opencode   │ HTTP
            │                   │  models")         │ (internal)
            ▼                   ▼                   ▼
┌─────────────────────┐  ┌─────────────────────┐  ┌──────────────┐
│ OpenCode Instance #1│  │   Model List CLI    │  │  OpenCode   │
│  port: 30000        │  │   stdout parse      │  │  HTTP API   │
│  cwd: workspace/... │  │                     │  │  /session   │
└─────────────────────┘  └─────────────────────┘  └──────────────┘

Event Stream (WebSocket push via conversationState.subscribe):
  conversation.prepared
  conversation.starting
  conversation.running
  conversation.ready
  conversation.readyLost
  conversation.stopped
  conversation.restarting
  conversation.destroyed
```

---

## 資料流

### 1. 準備對話

```
Client → POST /api/conversations (with model, agent)
  │
  ▼
AgentOrchestrator
  │ 1. 產生 UUID → workspace/{id}/
  │ 2. WorkspaceFactory.create(id, options) → 建立資料夾（`opencode.json` 僅在用戶 POST 時寫入）
  │ 3. ConversationState.create(id) → status = 'prepared'
  │ 4. 註冊 wsUrl (尚未分配 port，不啟動 OpenCode)
  │
  ▼
回傳 { id, status: 'prepared', wsUrl }
```

### 1.5. 啟動對話

```
Client → POST /api/conversations/{id}/start
  │
  ▼
AgentOrchestrator
  │ 1. ConversationState.transition(id, 'starting')
  │    → emit 'conversation.starting'
  │ 2. InstanceManager.createInstance(id, reuseWorkspace=true)
  │    │ 2a. 若 workspace 已存在 → 跳過 create，直接使用
  │    │ 2b. PortPool.allocate() → 動態端口
  │    │ 2c. spawn("opencode serve --port 30000", cwd=workspace/{id}/)
  │    │ 2d. 輪詢 GET /global/health 直到通過
  │    │ 2e. POST /session → 建立初始 Session
  │    ▼
  │ 3. ConversationState.transition(id, 'running')
  │    → setRunningInstance(port, sessionId)
  │    → emit 'conversation.running'
  │    → push to WebSocket subscribers
  │
  ▼
回傳 { status: 'running', port, sessionId }
```

### 2. 發送訊息（WebSocket）

```
Client → WS connect /ws/{conversationId}
  │
  ▼
AgentOrchestrator WS Router
  │ 1. 檢查 ConversationState.has(id)；若不存在 → reject (1011)
  │ 2. 訂閱 conversationState.subscribe(id, cb) → 接收事件推送
  │ 3. 接收 JSON-RPC 請求 (e.g. message.send)
  │ 4. 檢查 status === 'running'；若否 → reject (-32001 invalid state)
  │ 5. 查找 InstanceInfo (Map<conversationId>)
  │ 6. model 字串 → { providerID, modelID } (或 fallback 到 defaultModel)
  │ 7. agent → fallback 到 defaultAgent
  │
  ▼
HTTP POST → OpenCode /session/{sid}/message
  │ (OpenCode 內部處理 tool calling loop)
  │
  ▼
回傳 AI 回應 → AgentOrchestrator → WebSocket JSON-RPC result
```

### 3. 刪除對話

```
Client → DELETE /api/conversations/{id}
  │
  ▼
AgentOrchestrator
  │ 1. InstanceManager.destroyInstance(id) (若 running)
  │    │ 1a. treeKill(proc.pid) → 終止 OpenCode 進程樹
  │    │ 1b. PortPool.release(port)
  │ 2. ConversationState.transition(id, 'destroyed')
  │    → emit 'conversation.destroyed'
  │ 3. WorkspaceFactory.destroy(id) → rmSync(workspace/{id}/)
  │
  ▼
回傳 204 No Content
```

---

## OpenCode 實例生命週期

```
┌───────────┐
│ Prepared  │  (workspace created, no process yet)
└─────┬─────┘
      │ POST /start
      ▼
┌───────────┐     ┌──────────┐     ┌─────────────┐     ┌──────────┐
│ Starting  │────▶│ Spawning │────▶│ Health Check │────▶│ Running  │
│           │     │(spawn    │     │(poll /global  │     │(session  │
│           │     │ opencode │     │  /health)    │     │ created) │
└───────────┘     └──────────┘     └─────────────┘     └────┬─────┘
                                                             │
                                                startReadyCheck()
                                                             │
                                                             ▼
                                                    ┌──────────────┐
                                              ┌───▶│   Ready      │
                                              │    │(session GET  │
                                              │    │ succeed)     │
                                              │    └──────────────┘
                                              │           │
                                              │           │ keepalive fail
                                              │           ▼
                                              │    ┌──────────────┐
                                              └────│  Ready Lost  │
                                                   │(session GET  │
                                                   │  failed)     │
                                                   └──────────────┘
      │                                                     │
      │ POST /stop                                           │ POST /restart
      ▼                                                     ▼
┌───────────┐                                          ┌───────────┐
│ Stopped   │                                          │ Restarting│
│(process   │                                          │(stop old  │
│ killed,   │                                          │ process,  │
│ workspace │                                          │ keep ws,  │
│ kept)     │                                          │ respawn)  │
└─────┬─────┘                                          └─────┬─────┘
      │                                                     │
      └────────────────────────┬────────────────────────────┘
                                │
                                │ DELETE /{id} 或 LRU Eviction
                                ▼
                         ┌─────────────┐
                         │  Destroyed   │
                         │(treeKill +   │
                         │ rm workspace)│
                         └─────────────┘
```

---

## 核心模組

### `src/orchestrator/conversation-state.ts`

事件驅動的對話生命周期狀態機，管理從 `prepared` 到 `destroyed` 的所有狀態轉換，並提供訂閱機制供 WebSocket 推送即時事件。

**關鍵類別**：`ConversationState`

| 方法 | 職責 |
|------|------|
| `create(id)` | 建立對話狀態（`prepared`），允許預設 UUID |
| `get(id)` | 取得對話狀態與執行中實例資訊 |
| `has(id)` | 檢查對話是否存在 |
| `transition(id, toStatus)` | 原子性狀態轉換，觸發對應事件 |
| `setRunningInstance(id, port, sessionId)` | 記錄啟動後的實例資訊 |
| `removeRunningInstance(id)` | 清除實例資訊（停止時） |
| `subscribe(id, callback)` | WebSocket 訂閱事件流；回傳 unsubscribe 函式 |
| `getRecentEvents(id)` | 取得最近 100 條事件（供 REST `GET /events` 與重連時回放） |
| `emitEvent(id, type, payload?)` | 內部發射事件並寫入歷史 |
| `startReadyCheck(id)` | 啟動 `isReady` 輪詢：透過 `GET /session/{id}` 確認 OpenCode 已就緒；成功後 emit `conversation.ready`，後續 keepalive 失敗時 emit `conversation.readyLost` |

**`ConversationStatus`**：`prepared` → `starting` → `running` → `stopped` / `restarting` → `destroyed`

**額外欄位**：`ready`（boolean）－表示 OpenCode 實例是否已通過就緒檢查。`message.send` 需要 `ready === true` 才能執行。

---

### `src/orchestrator/instance-manager.ts`

管理所有 OpenCode 實例的生命周期。

**關鍵類別**：`InstanceManager`

| 方法 | 職責 |
|------|------|
| `createInstance(id, options?)` | 建立新實例：若 workspace 已存在則**直接重用**，分配端口、spawn OpenCode、健康檢查、建立 Session |
| `getInstance(id)` | 取得實例資訊，並更新 `lastUsedAt` |
| `destroyInstance(id)` | 銷毀實例：kill 進程、釋放端口（**保留 workspace**） |
| `listInstances()` | 列出所有活躍實例 |
| `evictLRU()` | 私有方法：達上限時淘汰最久未使用的實例 |

**`InstanceInfo` 結構**：
```ts
{
  id: string;              // conversation ID
  port: number;             // OpenCode 實例端口
  workspacePath: string;    // workspace 路徑
  process: ChildProcess;    // OpenCode 子進程
  client: OpenCodeClient;    // HTTP 客戶端（連到該實例）
  sessionId: string;        // OpenCode Session ID
  lastUsedAt: number;       // 最後使用時間戳
  isReady: boolean;         // 是否就緒
  defaultModel?: string;    // 對話預設模型
  defaultAgent?: string;    // 對話預設代理
}
```

---

### `src/orchestrator/port-pool.ts`

動態端口分配器，確保 OpenCode 實例端口不衝突。

**`PortPool`**：
- `allocate()` → 從可用端口池取出第一個端口
- `release(port)` → 將端口放回池中
- `getUsedCount()` → 取得已使用端口數量

---

### `src/orchestrator/workspace-factory.ts`

建立與管理每個對話的獨立 workspace，支援配置、Agent、檔案與 Skill 的 CRUD，以及本地檔案複製與配額管理。

**`WorkspaceFactory`**：

| 方法 | 職責 |
|------|------|
| `create(id, options?)` | 建立 workspace 資料夾；**不寫入** `opencode.json`（僅在用戶透過 POST 或 WS `config.update` 時才寫入） |
| `hasWorkspace(id)` | 檢查 workspace 是否已存在 |
| `ensure(id)` | 確保 workspace 存在（供重用時呼叫） |
| `destroy(id)` | 移除 workspace 資料夾 |
| `writeConfig(id, config)` / `readConfig(id)` | 覆寫 / 讀取 `opencode.json` |
| `writeAgent(id, name, content)` / `readAgent(id, name)` / `listAgents(id)` / `deleteAgent(id, name)` | Agent Markdown 檔案 CRUD（寫入 `.opencode/agents/*.md`，OpenCode 自動發現） |
| `writeFile(id, path, content)` / `readFile(id, path)` / `listFiles(id)` / `deleteFile(id, path)` | 通用檔案 CRUD（所有路徑經 `sanitizeRelativePath` 驗證） |
| `copyFromLocal(id, source, dest)` | 從本機 `{cwd}/assets/`、`{cwd}/templates/` 或 `{cwd}/skills/` 複製檔案/資料夾到 workspace |
| `importSkillFromLocal(id, source, name)` | 從本機 `{cwd}/skills/` 複製 Skill 目錄到 `.opencode/skills/{name}/` |
| `listSkills(id)` | 列出 `.opencode/skills/` 下的所有 Skill 目錄 |
| `readSkill(id, name)` | 讀取 `.opencode/skills/{name}/SKILL.md` 內容 |
| `getSkillInfo(id, name)` | 取得 Skill 目錄結構、總大小與 SHA-256 hash |
| `deleteSkill(id, name)` | 移除 `.opencode/skills/{name}/` 目錄；若不存在則拋出錯誤 |
| `calculateWorkspaceSize(id)` | 計算 workspace 總大小（遞迴） |

**規範配置強制合併**：
- `config/canonical-opencode.json` 為系統預設 `opencode.json` 模板，定義 `$schema` 與 `permission` 沙箱權限
- `enforceCanonicalConfig`（預設 `true`）：`writeConfig()` 時 deep-clone canonical 模板，僅接受使用者提供的**非 canonical keys**（如 `model`、`agent`），確保安全設定不被覆寫
- 設定 `workspace.enforceCanonicalConfig: false` 可關閉此行為，直接寫入使用者原始內容

**安全機制**：
- `sanitizeRelativePath(path)`：拒絕包含 `..` 的相對路徑與絕對路徑（`/...` 或 `C:\...`）
- `validateSkillName(name)`：拒絕非 `[A-Za-z0-9_-]` 的字元，最大長度 128；API 層應先驗證，factory 層作為 defense-in-depth
- 配額上限：`MAX_WORKSPACE_SIZE = 50 * 1024 * 1024` bytes（50 MB）；超過時寫入操作拒絕

---

### `src/opencode-http/client.ts`

與 OpenCode HTTP API 通訊的純 fetch 客戶端。

**`OpenCodeClient`**：
- 支援 Basic Auth（`Authorization: Basic ...`）
- 方法：`health()`, `createSession()`, `sendPrompt()`, `listMessages()`, `abortSession()`
- **新增**：`listSessions()`, `getSessionChildren(id)`, `forkSession(id, messageID?)` → 支援 OpenCode 會話樹遍歷

---

### `src/opencode-cli/models.ts`

執行 `opencode models` CLI 取得可用模型列表。

**`listModels(binary)`**：
- `spawn(binary, ['models'])`
- 解析 stdout（每行 `provider/model` 格式）
- 回傳 `{ id, provider, model }[]`

---

### `src/websocket/connection.ts`

處理單一 WebSocket 連線。

**`WSConnection`**：
- JSON-RPC 2.0 請求解析與 dispatch
- Heartbeat（ping/pong）機制
- Idle timeout（自動斷線）
- 事件推送（`sendEvent`）

---

### `src/websocket/router.ts`

WebSocket 連線路由器，將 `/ws/{id}` 路由到對應的對話；**不再自動建立實例**，所有操作都透過 `ConversationState` 檢查與事件訂閱。

**`WSRouter`**：
- 解析 URL 中的 `conversationId`
- 檢查 `conversationState.has(id)`；若不存在 → 關閉連線（code `1011`）
- 訂閱 `conversationState.subscribe(id)`，將事件即時推送給客戶端
- 處理 25+ JSON-RPC 方法，包括：
  - 會話類：`session.create`, `session.delete`, `session.list`
  - 訊息類：`message.send`, `message.history`
  - 對話控制類：`conversation.status`, `conversation.start`, `conversation.stop`, `conversation.restart`
  - 配置類：`config.get`, `config.update`
  - Agent 類：`agent.list`, `agent.read`, `agent.write`, `agent.delete`
  - 檔案類：`file.list`, `file.read`, `file.write`, `file.delete`
  - Skill 類：`skills.import`, `skills.list`, `skills.get`, `skills.info`, `skills.delete`
  - 事件類：`events.subscribe`, `events.unsubscribe`
- 若對話狀態非 `running`，執行需實例操作的方法時回傳 `-32001` invalid state

---

### `src/config-loader.ts`

設定載入與環境變數覆寫。

**`loadConfig()`**：
1. 讀取 `config/agentorchestrator.json`
2. `applyEnvOverrides()`：掃描 `AGENTORCHESTRATOR_*` 環境變數並覆寫對應路徑
3. 回傳 `AgentOrchestratorConfig` 型別物件

**`loadCanonicalConfig()`**：
- 讀取 `config/canonical-opencode.json`，作為所有 workspace 的 `opencode.json` 系統預設模板
- 內容固定包含 `$schema` 與 `permission` 沙箱權限區塊
- 供 `WorkspaceFactory.writeConfig()` 在 `enforceCanonicalConfig=true` 時合併使用

---

## 安全設計

1. **進程級隔離**：每個對話獨立 `opencode serve`，互不影響
2. **檔案系統沙箱**：`config/canonical-opencode.json` 定義系統預設 `$schema` 與 `permission` 區塊，寫入 `opencode.json` 時強制合併（`enforceCanonicalConfig=true` 預設），確保權限設定不被使用者覆寫
3. **動態 Basic Auth**：每個 OpenCode 實例自動生成獨立密碼，避免與使用者全域設定衝突
4. **自動資源回收**：LRU 淘汰與刪除時的 `treeKill` + `rmSync`，防止殭屍進程與磁碟洩漏
5. **Workspace 配額限制**：單一 workspace 上限 50 MB，超過時寫入操作被拒絕
6. **路徑遍歷防護**：所有檔案操作必須通過 `sanitizeRelativePath()`，拒絕 `..` 與絕對路徑；檔案路徑統一放於 request body 或 query string，避免 URL routing 層被惡意路徑段繞過
7. **本地複製白名單**：`copyFromLocal` 與 `importSkillFromLocal` 僅允許來源為 `{cwd}/assets/`、`{cwd}/templates/` 或 `{cwd}/skills/`；使用 `resolve()` + `sep` 邊界檢查取代字首比對，前綴相同的兄弟目錄（如 `skills_evil/`）一律拒絕
8. **Skill 名稱驗證**：`validateSkillName()` 只允許 `[A-Za-z0-9_-]`，最大長度 128；API 層拒絕非法名稱後才進入檔案系統操作
9. **Zip Slip 防護**：`skills/upload` 逐條驗證 zip entry 路徑，拒絕 `..`、絕對路徑與磁碟機路徑；`resolve()` 確認最終輸出路徑仍在 `destPath` 內才執行 extraction
10. **Skill 結構驗證**：`skills/upload` 要求 zip 根層級必須包含 `SKILL.md`，否則直接拒絕
11. **未壓縮大小檢查**：`skills/upload` 計算 `sum(entry.header.size)` 並調用 `assertQuota`，防止 zip bomb 繞過 request body limit
12. **延遲啟動隔離**：`POST /conversations` 僅建立 workspace，不啟動 OpenCode；Agent 與 Skill 可在啟動前預先注入，確保 OpenCode 啟動時即擁有完整上下文，同時避免未準備完成的實例被外部誤用
