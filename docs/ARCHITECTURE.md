# 架構說明

## 概覽

AgentOrchestrator 是一個 Node.js 長期執行服務，作為 OpenCode 實例的編排器（Orchestrator），為每個對話（Conversation）動態建立獨立的 `opencode serve` 進程，並透過 HTTP REST API 與 WebSocket 提供統一的外部介面。

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
│                    AgentOrchestrator HTTP API                     │
│  • Express Server (port 0 = auto-allocated)                 │
│  • WebSocket upgrade handling                               │
│  • JSON-RPC 2.0 dispatch                                    │
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
```

---

## 資料流

### 1. 建立對話

```
Client → POST /api/conversations (with model, agent)
  │
  ▼
AgentOrchestrator
  │ 1. 產生 UUID → workspace/{id}/
  │ 2. 寫入 opencode.json (permissions + model + agent)
  │ 3. PortPool.allocate() → 動態端口 (e.g., 30000)
  │ 4. spawn("opencode serve --port 30000", cwd=workspace/{id}/)
  │ 5. 輪詢 GET /global/health 直到通過
  │ 6. POST /session → 建立初始 Session
  │ 7. 註冊 InstanceInfo (含 defaultModel, defaultAgent)
  │
  ▼
回傳 { id, wsUrl, port, sessionId, model, agent }
```

### 2. 發送訊息（WebSocket）

```
Client → WS connect /ws/{conversationId}
  │
  ▼
AgentOrchestrator WS Router
  │ 1. 查找 InstanceInfo (Map<conversationId>)
  │ 2. 解析 JSON-RPC message.send
  │ 3. model 字串 → { providerID, modelID } (或 fallback 到 defaultModel)
  │ 4. agent → fallback 到 defaultAgent
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
  │ 1. InstanceManager.destroyInstance(id)
  │ 2. treeKill(proc.pid) → 終止 OpenCode 進程樹
  3. PortPool.release(port)
  4. rmSync(workspace/{id}/) → 移除 workspace
  │
  ▼
回傳 204 No Content
```

---

## OpenCode 實例生命週期

```
┌─────────┐     ┌──────────┐     ┌─────────────┐     ┌──────────┐
│ Created │────▶│ Spawning │────▶│ Health Check │────▶│  Ready   │
│(allocate│     │(spawn    │     │(poll /global │     │(session  │
│ port &  │     │ opencode │     │  /health)    │     │ created) │
│ workspace)│     │ serve)   │     │              │     │          │
└─────────┘     └──────────┘     └─────────────┘     └────┬─────┘
                                                            │
                                 ┌──────────────────────────┘
                                 │  LRU Eviction / User Delete
                                 ▼
                          ┌─────────────┐
                          │  Destroyed   │
                          │(treeKill +   │
                          │ rm workspace)│
                          └─────────────┘
```

---

## 核心模組

### `src/orchestrator/instance-manager.ts`

管理所有 OpenCode 實例的生命周期。

**關鍵類別**：`InstanceManager`

| 方法 | 職責 |
|------|------|
| `createInstance(id, options?)` | 建立新實例：分配端口、建立 workspace、spawn OpenCode、健康檢查、建立 Session |
| `getInstance(id)` | 取得實例資訊，並更新 `lastUsedAt` |
| `destroyInstance(id)` | 銷毀實例：kill 進程、釋放端口、移除 workspace |
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

### `src/orchestrator/port-pool.ts`

動態端口分配器，確保 OpenCode 實例端口不衝突。

**`PortPool`**：
- `allocate()` → 從可用端口池取出第一個端口
- `release(port)` → 將端口放回池中
- `getUsedCount()` → 取得已使用端口數量

### `src/orchestrator/workspace-factory.ts`

建立每個對話的獨立 workspace。

**`WorkspaceFactory.create(id, options?)`**：
1. `mkdir -p workspace/{id}/.opencode/`
2. 生成 `opencode.json`：
   - `$schema`
   - `permission`（沙箱限制）
   - `model`（若指定）
   - `agent`（若指定）

### `src/opencode-http/client.ts`

與 OpenCode HTTP API 通訊的純 fetch 客戶端。

**`OpenCodeClient`**：
- 支援 Basic Auth（`Authorization: Basic ...`）
- 方法：`health()`, `createSession()`, `sendPrompt()`, `listMessages()`, `abortSession()`

### `src/opencode-cli/models.ts`

執行 `opencode models` CLI 取得可用模型列表。

**`listModels(binary)`**：
- `spawn(binary, ['models'])`
- 解析 stdout（每行 `provider/model` 格式）
- 回傳 `{ id, provider, model }[]`

### `src/websocket/connection.ts`

處理單一 WebSocket 連線。

**`WSConnection`**：
- JSON-RPC 2.0 請求解析與 dispatch
- Heartbeat（ping/pong）機制
- Idle timeout（自動斷線）
- 事件推送（`sendEvent`）

### `src/websocket/router.ts`

WebSocket 連線路由器，將 `/ws/{id}` 路由到對應的 OpenCode 實例。

**`WSRouter`**：
- 解析 URL 中的 `conversationId`
- 若實例不存在，自動建立新實例
- 處理 `message.send` / `message.history` / `session.abort`
- model 字串 → `{ providerID, modelID }` 轉換與 fallback 邏輯

### `src/config-loader.ts`

設定載入與環境變數覆寫。

**`loadConfig()`**：
1. 讀取 `config/agentswitch.json`
2. `applyEnvOverrides()`：掃描 `AGENTSWITCH_*` 環境變數並覆寫對應路徑
3. 回傳 `AgentOrchestratorConfig` 型別物件

---

## 安全設計

1. **進程級隔離**：每個對話獨立 `opencode serve`，互不影響
2. **檔案系統沙箱**：`opencode.json` 限制 `external_directory: deny`，工具只能存取 workspace 內檔案
3. **動態 Basic Auth**：每個 OpenCode 實例自動生成獨立密碼，避免與使用者全域設定衝突
4. **自動資源回收**：LRU 淘汰與刪除時的 `treeKill` + `rmSync`，防止殭屍進程與磁碟洩漏
