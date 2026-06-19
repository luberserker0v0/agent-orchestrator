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
            │  HTTP POST        │  WS /ws/{id}      │
            │  /api/conversations│                   │
            ▼                   ▼
┌─────────────────────────────────────────────────────────────┐
│                    Transport Layer                           │
│  • Express HTTP Server (route handlers)                     │
│  • WebSocket JSON-RPC Router (method dispatch)              │
│  Both delegate to Service Layer — no direct domain access   │
└──────────────────────────────┬──────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────┐
│                     Service Layer                            │
│  • ConversationService  • FileService   • MessageService    │
│  • SessionService       • ConfigService • AgentService      │
│  • SkillService                                             │
│  Business logic, validation, orchestration of domain calls  │
└────────────┬─────────────────────┬──────────────────────────┘
              │                     │
              ▼                     ▼
┌─────────────────────────┐  ┌──────────────────┐
│    Domain Layer         │  │  OpenCode HTTP   │
│  • ConversationState    │  │  API (internal)  │
│  • InstanceManager      │  │  /session        │
│  • RuntimeManager       │  │  /global/health  │
│  • WorkspaceFactory     │  │  /provider       │
│  • PortPool             │  └──────────────────┘
└─────────────────────────┘
              │
               │ RuntimeManager (delegates to RuntimeRegistry for spawn/kill)
              ▼
┌─────────────────────────────────────────────────────────────┐
│                Runtime Abstraction Layer                     │
│  • RuntimeRegistry (id → AgentRuntime)                      │
│  • RuntimeManager (instance map, lifecycle, policy queries) │
│    •  AgentRuntime (interface: start, stop, restart, cleanupOrphans)  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  DirectRuntime / DockerRuntime                        │  │
│  └──────────────────────────┬────────────────────────────┘  │
└─────────────────────────────┼───────────────────────────────┘
                               │ start() / stop()
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                     OpenCode Instance                        │
│  port: 30000   cwd: workspace/...                           │
│  process | container   client: OpenCodeClient                │
└─────────────────────────────────────────────────────────────┘

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
Client → POST /api/conversations
  │
  ▼
AgentOrchestrator HTTP Server
  │ 1. 呼叫 ConversationService.create(id?)
  │    │ 1a. WorkspaceFactory.create(id) → 建立資料夾（`opencode.json` 僅在用戶 POST 時寫入）
  │    │ 1b. ConversationState.create(id) → status = 'prepared'
  │    │ 1c. 註冊 wsUrl (尚未分配 port，不啟動 OpenCode)
  │
  ▼
回傳 { id, status: 'prepared', wsUrl }
```

### 1.5. 啟動對話

```
Client → POST /api/conversations/{id}/start
  │
  ▼
AgentOrchestrator HTTP Server → ConversationService.start(id)
  │ 1. ConversationService 呼叫 InstanceManager.createInstance(id)
  │    │ 1a. 若 workspace 已存在 → 跳過 create，直接使用
  │    │ 1b. PortPool.allocate() → 動態端口
   │    │ 1c. RuntimeManager.start(id, port, workspacePath, auth)
  │    │     → 啟動 OpenCode（direct spawn 或 Docker 容器）
  │    │ 1d. 輪詢 GET /global/health 直到通過
  │    │ 1e. POST /session → 建立初始 Session（background）
  │    ▼
  │ 2. ConversationService 更新 ConversationState → status = 'running'
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
  │ 1. 呼叫 ConversationService.get(id) 檢查對話是否存在；若不存在 → reject (1011)
  │ 2. 訂閱 conversationState.subscribe(id, cb) → 接收事件推送
  │ 3. 接收 JSON-RPC 請求 (e.g. message.send)
  │ 4. 透過 ConversationService.get(id) 檢查 status === 'running'；若否 → reject error
  │ 5. 呼叫 MessageService.send(id, text, model?, agent?)
  │    │ 5a. 檢查 status === 'running' && ready === true；若否 → reject
  │    │ 5b. 透過 SessionService.ensureReady(id) 確保 session 可用
  │    │ 5c. ModelParser.parse(model) → { providerID, modelID }
  │    │ 5d. HTTP POST → OpenCode /session/{sid}/message
  │    │ 5e. emit 'conversation.message' event
  │
  ▼
HTTP POST → OpenCode /session/{sid}/message
  │ (OpenCode 內部處理 tool calling loop)
  │
  ▼
回傳 AI 回應 → MessageService → WS Router → WebSocket JSON-RPC result
```

### 3. 刪除對話

```
Client → DELETE /api/conversations/{id}
  │
  ▼
AgentOrchestrator HTTP Server → ConversationService.delete(id)
  │ 1. ConversationService 呼叫 InstanceManager.destroyInstance(id) (若 running)
   │    │ 1a. runtime.stop(id) → 終止 OpenCode（direct 模式 tree-kill，docker 模式 kill container）
  │    │ 1b. PortPool.release(port)
  │ 2. ConversationService 更新 ConversationState → status = 'destroyed'
  │    → emit 'conversation.destroyed'
  │ 3. ConversationService 呼叫 WorkspaceFactory.destroy(id) → rmSync(workspace/{id}/)
  │    (若步驟 1 或 2 失敗，仍嘗試執行步驟 3)
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

### `src/services/` — Service Layer

Service Layer 是 transport（HTTP/WS）與 domain（InstanceManager、ConversationState、WorkspaceFactory）之間的中間層。Transport 層不直接操作 domain 元件，全部透過 Service 委派。

---

#### `src/services/conversation-service.ts`

對話生命週期編排（prepared → running → stopped → destroyed）。

**`ConversationService`**：

| 方法 | 職責 |
|------|------|
| `create(id?)` | 建立 workspace + ConversationState，回傳對話資訊 |
| `start(id)` | 啟動 OpenCode：InstanceManager.createInstance → ConversationState transition |
| `stop(id)` | 停止 OpenCode：InstanceManager.destroyInstance → ConversationState transition（保留 workspace） |
| `restart(id)` | 重啟：先 stop 再 start（保留 workspace） |
| `delete(id)` | 刪除：InstanceManager.destroyInstance → ConversationState transition → WorkspaceFactory.destroy（catch 各步驟錯誤） |
| `get(id)` | 取得對話狀態與實例資訊 |
| `list()` | 列出所有對話 |
| `getEvents(id, limit?)` | 取得最近事件歷史 |

---

#### `src/services/file-service.ts`

檔案 CRUD，含 50MB 配額強制。

**`FileService`**：

| 方法 | 職責 |
|------|------|
| `write(id, path, content)` | 寫入檔案前檢查配額，拒絕超過 50MB 的操作 |
| `read(id, path)` | 讀取檔案內容 |
| `delete(id, path)` | 刪除檔案 |
| `copy(id, source, dest)` | 從本地白名單路徑複製檔案到 workspace |
| `list(id, path?)` | 列出目錄內容 |

---

#### `src/services/session-service.ts`

OpenCode Session 代理，含 `ensureReady` 保護。

**`SessionService`**：

| 方法 | 職責 |
|------|------|
| `create(id, params?)` | 建立新會話，檢查 status=running && ready=true |
| `list(id)` | 列出所有會話 |
| `get(id, sessionId)` | 取得指定會話 |
| `delete(id, sessionId)` | 刪除會話 |
| `fork(id, sessionId, messageID?)` | 從指定會話分支 |
| `getChildren(id, sessionId)` | 取得子會話 |
| `abort(id)` | 中止當前生成 |
| `listProviders(id)` | 取得模型提供商列表 |
| `ensureReady(id)` | 內部保護：確認 OpenCode 已就緒（status=running && ready=true） |

---

#### `src/services/message-service.ts`

訊息發送與歷史，含 model 字串解析與事件發射。

**`MessageService`**：

| 方法 | 職責 |
|------|------|
| `send(id, text, model?, agent?)` | 發送訊息：解析 model→providerID/modelID，確保 session 就緒，呼叫 OpenCode API，emit conversation.message 事件 |
| `getHistory(id, sessionId?, limit?)` | 取得對話歷史 |

---

### Domain Layer (`src/orchestrator/`)

對話生命周期管理、進程編排、端口分配與 workspace 檔案操作的核心領域邏輯。不直接依賴 Runtime 實作，而是透過 `RuntimeRegistry` 間接操作。

---

#### `src/orchestrator/conversation-state.ts`

事件驅動的對話生命周期狀態機，管理從 `prepared` 到 `destroyed` 的所有狀態轉換，並提供訂閱機制供 WebSocket 推送即時事件。每次 `transition()` 呼叫會增加 `agentorchestrator_conversation_state_changes_total{status="<to>"}` counter。

#### `src/utils/logger.ts`

結構化日誌工具，支援動態日誌層級與格式切換。

**`Logger`**：
- 層級：`debug` < `info` < `warn` < `error`
- 格式：`text`（人類可讀時間戳+層級+訊息）或 `json`（結構化 JSON）
- `Logger.child(context: object)`：建立綁定 context 的子 Logger，所有輸出自動附加固定欄位（如 `requestId`、`conversationId`），適合非同步請求追蹤

#### `src/metrics/registry.ts`

Prometheus 指標註冊中心，整合 `prom-client`。

**自訂指標**（共 9 項）：
| Metric | Type | Labels |
|--------|------|--------|
| `agentorchestrator_instances_active` | Gauge | — |
| `agentorchestrator_instances_total_created` | Counter | — |
| `agentorchestrator_instances_errors_total` | Counter | `type` (spawn, health, kill) |
| `agentorchestrator_instance_spawn_duration_seconds` | Histogram | — |
| `agentorchestrator_port_pool_available` | Gauge | — |
| `agentorchestrator_websocket_connections_active` | Gauge | — |
| `agentorchestrator_http_requests_total` | Counter | `method`, `status` |
| `agentorchestrator_http_request_duration_seconds` | Histogram | `method`, `status` |
| `agentorchestrator_conversation_state_changes_total` | Counter | `status` |

**關鍵類別**：`ConversationState`

| 方法 | 職責 |
|------|------|
| `create(id)` | 建立對話狀態（`prepared`），允許預設 UUID |
| `get(id)` | 取得對話狀態與執行中實例資訊 |
| `has(id)` | 檢查對話是否存在 |
| `transition(id, toStatus)` | 原子性狀態轉換，觸發對應事件 |
| `setRunningInstance(id, info)` | 記錄啟動後的實例資訊（`process`、`client`） |
| `setInstanceInfo(id, info)` | 記錄實例元資訊（`port`、`sessionId`、`wsUrl`） |
| `removeRunningInstance(id)` | 清除實例資訊（停止時） |
| `subscribe(id, callback)` | WebSocket 訂閱事件流；回傳 unsubscribe 函式 |
| `getRecentEvents(id, limit?)` | 取得最近事件（預設 50 條，最多 100，供 REST `GET /events` 與重連時回放） |
| `emitEvent(id, type, payload?)` | 內部發射事件並寫入歷史 |
| `startReadyCheck(id)` | 啟動 `isReady` 輪詢：透過 `GET /session/{id}` 確認 OpenCode 已就緒；成功後 emit `conversation.ready`，後續 keepalive 失敗時 emit `conversation.readyLost` |

**`ConversationStatus`**：`prepared` → `starting` → `running` → `stopped` / `restarting` → `destroyed`

**額外欄位**：`ready`（boolean）－表示 OpenCode 實例是否已通過就緒檢查。`message.send` 需要 `ready === true` 才能執行。

---

### Runtime Abstraction Layer (`src/agent-runtime/`)

獨立的可插拔 Runtime 抽象層，定義 `AgentRuntime` 介面、`InstanceHandle` 抽象、共享健康檢查工具，並提供 `DirectRuntime` 與 `DockerRuntime` 兩種實作。`InstanceManager` 不直接操作 Runtime，而是透過 `RuntimeManager` 間接操作，再由 `RuntimeManager` 委派 `RuntimeRegistry` 查詢對應的 `AgentRuntime` 實作來 start/stop/restart/cleanupOrphans。

**`src/agent-runtime/types.ts`** — `AgentRuntime` 介面、`AgentEndpoint`、`InstanceHandle`、`HealthCheckConfig` 型別：

```ts
interface AgentRuntime {
  start(id: string, port: number, workspacePath: string, auth: { username: string; password: string }): Promise<AgentEndpoint>;
  stop(id: string): Promise<void>;
  restart(id: string, workspacePath: string, healthCheckConfig: HealthCheckConfig): Promise<AgentEndpoint>;
  cleanupOrphans(): Promise<void>;
}

interface AgentEndpoint {
  handle?: InstanceHandle;  // 本地進程或 docker handle，可選（如 API agent 無 handle）
  client: OpenCodeClient;   // HTTP 客戶端（連到該實例）
  port?: number;            // 監聽埠，可選（API agent 不用 port）
}

interface InstanceHandle {
  pid: number;
  exitCode: number | null;
  kill(signal?: string): Promise<void>;
  waitForExit(): Promise<number | null>;
  onExit(callback: (code: number | null) => void): void;
}
```

**`src/agent-runtime/registry.ts`** — `RuntimeRegistry`：依 `id` 字串註冊與查詢對應的 Runtime 實作。

**`src/agent-runtime/runtime-manager.ts`** — `RuntimeManager`：管理所有活躍實例的狀態映射（`Map<string, InstanceInfo>`），提供實例註冊/查詢/銷毀，以及政策查詢方法（LRU 淘汰候選、閒置偵測），委派 `RuntimeRegistry` 進行實際 spawn/kill/restart 操作。

**`src/agent-runtime/health.ts`** — 共享健康檢查工具：

```ts
function waitForHealthy(
  client: OpenCodeClient,
  config: HealthCheckConfig,
  logger?: Logger
): Promise<void>;
```

- 封裝輪詢 `GET /global/health` 的邏輯
- 接受 `retries`、`intervalMs`、`clientTimeoutMs` 參數
- 所有 runtime 實作（DirectRuntime、DockerRuntime）共享此工具，消除重複程式碼

**`src/agent-runtime/runtimes/direct.ts`** — `DirectRuntime`：
- 使用 `cross-spawn` 啟動 `opencode serve` 為子進程
- `ChildProcessHandle` 包裝 `ChildProcess` + `treeKill` 實作 `InstanceHandle`
- 接受 `DirectRuntimeConfig`（`{ binary, instanceHost }`）
- 支援可設定的 `instanceHost`（預設 `127.0.0.1`）

**`src/agent-runtime/runtimes/docker.ts`** — `DockerRuntime`：
- 使用 `docker run` 啟動 OpenCode 容器
- `DockerHandle` 包裝 `docker rm -f` 實作 `InstanceHandle`
- 接受 `DockerRuntimeConfig`（`{ binary, instanceHost, docker: { image, containerPort, networkMode } }`）
- 支援 `networkMode`：`'host'` 跳過 port mapping；`'bridge'` 或自訂網路名稱加入 `--network` 旗標

---

#### `src/orchestrator/instance-manager.ts`

管理所有 OpenCode 實例的生命周期，透過 `RuntimeManager` 委派對應的 runtime 實作。`RuntimeManager` 維護實例狀態映射，並提供政策查詢（LRU 候選、閒置偵測）供 `InstanceManager` 執行淘汰決策。

**關鍵類別**：`InstanceManager`

| 方法 | 職責 |
|------|------|
| `createInstance(id, agentType?)` | 建立新實例：若 workspace 已存在則**直接重用**，分配端口、透過 RuntimeManager.start() 啟動 OpenCode、健康檢查、建立 Session |
| `getInstance(id)` | 取得實例資訊（委派 RuntimeManager） |
| `destroyInstance(id)` | 銷毀實例（委派 RuntimeManager） |
| `stopInstance(id)` | 停止實例（委派 RuntimeManager），**保留 workspace** |
| `restartInstance(id)` | 嘗試原地重啟（委派 RuntimeManager.restartInstance），fallback 到 stop + create |
| `listInstances()` | 列出所有活躍實例（委派 RuntimeManager） |
| `cleanupOrphanContainers()` | 迭代所有已註冊 runtime，呼叫其 cleanupOrphans()（委派 RuntimeManager） |

**日誌與指標**：
- `createInstance` 記錄 spawn 持續時間至 `agentorchestrator_instance_spawn_duration_seconds` histogram
- `destroyInstance` / `stopInstance` 在 runtime.stop() 失敗時增加 `agentorchestrator_instances_errors_total{type="stop"}` counter
- 錯誤事件（start、health check、stop）使用綁定 conversationId 的 logger 輸出
```ts
{
  id: string;              // conversation ID
  port: number;             // OpenCode 實例端口
  workspacePath: string;    // workspace 路徑
  process?: ChildProcess;   // OpenCode 子進程（可選，runtime 可能無本地進程）
  client: OpenCodeClient;    // HTTP 客戶端（連到該實例）
  lastUsedAt: number;       // 最後使用時間戳
}
```
> `sessionId` 與 `ready` 狀態存於 `ConversationState` 而非 `InstanceInfo`。`createSessionInBackground()` 會非同步建立 Session 並更新至 ConversationState。

---

#### `src/orchestrator/port-pool.ts`

動態端口分配器，確保 OpenCode 實例端口不衝突。

**`PortPool`**：
- `allocate()` → 從可用端口池取出第一個端口；若範圍耗盡且 `allowDynamicFallback=true`，自動退回到 OS 分配端口（bind `0`）
- `release(port)` → 將端口放回池中（所有端口皆回收使用）
- `getUsedCount()` → 取得已使用端口數量
- `allowDynamicFallback`（建構參數）— 設定為 `true` 時，範圍耗盡不拋錯，改為 OS 分配；預設 `true`

---

#### `src/orchestrator/workspace-factory.ts`

建立與管理每個對話的獨立 workspace，支援配置、Agent、檔案與 Skill 的 CRUD，以及本地檔案複製與配額管理。

**`WorkspaceFactory`**：

| 方法 | 職責 |
|------|------|
| `create(id?)` | 建立 workspace 資料夾；**不寫入** `opencode.json`（僅在用戶透過 POST 或 WS `config.update` 時才寫入） |
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
| `getWorkspaceSize(id)` | 計算 workspace 總大小（遞迴） |

**規範配置強制合併**：
- `config/canonical-opencode.example.json` 為系統預設 `opencode.json` 模板，定義 `$schema` 與 `permission` 沙箱權限
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

WebSocket 連線路由器，將 `/ws/{id}` 路由到對應的對話。**不再自動建立實例**，所有操作都透過 Service Layer 委派。

**`WSRouter`**：
- 解析 URL 中的 `conversationId`
- 呼叫 `ConversationService.get(id)` 檢查對話是否存在；若不存在 → 關閉連線（code `1011`）
- 訂閱 `conversationState.subscribe(id)`，將事件即時推送給客戶端
- 處理 25+ JSON-RPC 方法，全數委派給對應 Service：
  - 會話類 → `SessionService`
  - 訊息類 → `MessageService`
  - 對話控制類 → `ConversationService`
  - 配置類 → `ConfigService`
  - Agent 類 → `AgentService`
  - 檔案類 → `FileService`
  - Skill 類 → `SkillService`
  - 事件類：自動推送（連線即訂閱，無需顯式 RPC）
- 若對話狀態非 `running`，執行需實例操作的方法時回傳 `-32001` invalid state

---

### `src/config-loader.ts`

設定載入與環境變數覆寫。

**`loadConfig()`**：
1. 讀取 `config/agentorchestrator.json`
2. `applyEnvOverrides()`：掃描 `AGENTORCHESTRATOR_*` 環境變數並覆寫對應路徑（陣列型欄位如 `runtimes[]` 不支援 env 覆寫）
3. 回傳 `AgentOrchestratorConfig` 型別物件

**`loadCanonicalConfig()`**：
- 讀取 `config/canonical-opencode.example.json`，作為所有 workspace 的 `opencode.json` 系統預設模板
- 內容固定包含 `$schema` 與 `permission` 沙箱權限區塊
- 供 `WorkspaceFactory.writeConfig()` 在 `enforceCanonicalConfig=true` 時合併使用

---

### `src/http-api/server.ts` — HTTP 伺服器與安全層

Express HTTP 伺服器，整合認證、安全標頭與指標中介層。

**功能**：
- **API 金鑰認證**：當 `server.apiKey` 設定時（最少 8 字元），所有請求（除 `/health`、`/metrics`、`/api-docs*` 外）需要 `Authorization: Bearer <key>` 標頭
- **安全標頭**：所有回應附加 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`X-DNS-Prefetch-Control: off`
- **請求持續時間指標**：每個 HTTP 請求記錄至 `agentorchestrator_http_request_duration_seconds` 與 `agentorchestrator_http_requests_total`
- **CORS**：支援跨域請求，`Authorization` 標頭列入 allow list

---

## 安全設計

1. **進程級隔離**：每個對話獨立 `opencode serve`，互不影響
2. **檔案系統沙箱**：`config/canonical-opencode.example.json` 定義系統預設 `$schema` 與 `permission` 區塊，寫入 `opencode.json` 時強制合併（`enforceCanonicalConfig=true` 預設），確保權限設定不被使用者覆寫
3. **動態 Basic Auth**：每個 OpenCode 實例自動生成獨立密碼，避免與使用者全域設定衝突
4. **API 金鑰認證**：可選的 Bearer token 認證（`server.apiKey`），保護服務端點免於未授權存取。`/health`、`/metrics`、`/api-docs*` 端點不需認證
4. **安全 HTTP 標頭**：所有 HTTP 回應自動注入 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`X-DNS-Prefetch-Control: off`
5. **自動資源回收**：LRU 淘汰與刪除時的 `treeKill` + `rmSync`，防止殭屍進程與磁碟洩漏
6. **Workspace 配額限制**：單一 workspace 上限可設定（`workspace.maxSizeBytes`，預設 50 MB），超過時寫入操作被拒絕
7. **路徑遍歷防護**：所有檔案操作必須通過 `sanitizeRelativePath()`，拒絕 `..` 與絕對路徑；檔案路徑統一放於 request body 或 query string，避免 URL routing 層被惡意路徑段繞過
7. **本地複製白名單**：`copyFromLocal` 與 `importSkillFromLocal` 僅允許來源為 `{cwd}/assets/`、`{cwd}/templates/` 或 `{cwd}/skills/`；使用 `resolve()` + `sep` 邊界檢查取代字首比對，前綴相同的兄弟目錄（如 `skills_evil/`）一律拒絕
9. **Skill 名稱驗證**：`validateSkillName()` 只允許 `[A-Za-z0-9_-]`，最大長度 128；API 層拒絕非法名稱後才進入檔案系統操作
10. **Zip Slip 防護**：`skills/upload` 逐條驗證 zip entry 路徑，拒絕 `..`、絕對路徑與磁碟機路徑；`resolve()` 確認最終輸出路徑仍在 `destPath` 內才執行 extraction
11. **Skill 結構驗證**：`skills/upload` 要求 zip 根層級必須包含 `SKILL.md`，否則直接拒絕
12. **未壓縮大小檢查**：`skills/upload` 計算 `sum(entry.header.size)` 並調用 `assertQuota`，防止 zip bomb 繞過 request body limit
13. **延遲啟動隔離**：`POST /conversations` 僅建立 workspace，不啟動 OpenCode；Agent 與 Skill 可在啟動前預先注入，確保 OpenCode 啟動時即擁有完整上下文，同時避免未準備完成的實例被外部誤用
