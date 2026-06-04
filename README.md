# AgentOrchestrator

一個 Node.js 編排器（Orchestrator），為每個對話（Conversation）動態建立獨立的 [OpenCode](https://opencode.ai) 實例，透過 HTTP 與 WebSocket 提供型別安全的 API 介面。

---

## 功能特性

- **進程級隔離**：每個對話擁有獨立的 `opencode serve` 實例，CWD 指向專屬 workspace
- **權限沙箱**：透過 `opencode.json` 限制 `external_directory` 與 `bash` 權限，防止越界存取
- **動態端口分配**：OpenCode 實例自動分配端口，無需手動管理
- **LRU 資源淘汰**：達到上限時自動回收最久未使用的實例
- **WebSocket 即時通訊**：JSON-RPC 2.0 協議，支援 heartbeat 與 idle timeout
- **Basic Auth 自動注入**：每個 OpenCode 實例動態生成密碼，避免與使用者全域設定衝突
- **跨平台**：支援 Windows、macOS、Linux（透過 `cross-spawn` 與 `tree-kill`）

---

## 前置需求

- **Node.js** >= 18.0.0
- **OpenCode CLI** 已安裝（執行 `opencode --version` 確認）
- 指定的端口範圍未被占用（預設 `30000-30100`）

---

## 安裝

```bash
git clone <repository-url>
cd agentswitch
npm install
```

---

## 設定檔

設定檔位於 `config/agentswitch.json`：

```json
{
  "server": {
    "port": 0,
    "host": "127.0.0.1"
  },
  "websocket": {
    "heartbeatIntervalMs": 30000,
    "idleTimeoutMs": 600000
  },
  "orchestrator": {
    "maxInstances": 10,
    "portRange": {
      "start": 30000,
      "end": 30100
    },
    "opencodeBinary": "opencode",
    "healthCheck": {
      "retries": 10,
      "intervalMs": 500
    }
  },
  "workspace": {
    "basePath": "./workspace",
    "defaultPermissions": {
      "external_directory": { "*": "deny" },
      "bash": { "*": "deny" }
    }
  }
}
```

### 欄位說明

| 欄位 | 類型 | 說明 | 預設值 |
|------|------|------|--------|
| `server.port` | `number` | HTTP 服務端口，`0` 表示由作業系統自動分配 | `0` |
| `server.host` | `string` | 綁定主機 | `127.0.0.1` |
| `websocket.heartbeatIntervalMs` | `number` | WebSocket 心跳間隔（毫秒） | `30000` |
| `websocket.idleTimeoutMs` | `number` | WebSocket 空閒斷線超時（毫秒） | `600000` |
| `orchestrator.maxInstances` | `number` | 最大同時存活 OpenCode 實例數 | `10` |
| `orchestrator.portRange.start` | `number` | OpenCode 動態端口範圍起始 | `30000` |
| `orchestrator.portRange.end` | `number` | OpenCode 動態端口範圍結束 | `30100` |
| `orchestrator.opencodeBinary` | `string` | OpenCode CLI 指令或絕對路徑 | `opencode` |
| `orchestrator.healthCheck.retries` | `number` | 啟動時健康檢查重試次數 | `10` |
| `orchestrator.healthCheck.intervalMs` | `number` | 健康檢查重試間隔 | `500` |
| `workspace.basePath` | `string` | Workspace 資料夾根目錄 | `./workspace` |
| `workspace.defaultPermissions` | `object` | 每個 workspace 內 `opencode.json` 的權限設定 | — |

### 環境變數覆寫

任何 `config/agentswitch.json` 的欄位都可以透過環境變數覆寫，命名規則為 `AGENTSWITCH_<path>`（底線分隔、小寫駝峰）：

```bash
# 覆寫 server.port
AGENTSWITCH_SERVER_PORT=8080

# 覆寫 orchestrator.maxInstances
AGENTSWITCH_ORCHESTRATOR_MAX_INSTANCES=20

# 覆寫 opencodeBinary 為絕對路徑
AGENTSWITCH_ORCHESTRATOR_OPENCODE_BINARY=/usr/local/bin/opencode
```

---

## 啟動

### 開發模式

```bash
npm run dev
```

### 編譯與生產模式

```bash
npm run build
npm start
```

啟動成功後，日誌會輸出實際監聽的端口與 WebSocket endpoint：

```
AgentOrchestrator listening on http://127.0.0.1:11697
WebSocket endpoint: ws://127.0.0.1:11697/ws/{conversationId}
```

---

## API 文件

完整 API 說明請參考 [`docs/API.md`](docs/API.md)。

### API 索引

**REST API**：

| 方法 | 端點 | 說明 |
|------|------|------|
| `GET` | `/health` | 健康檢查 |
| `POST` | `/api/conversations` | 建立對話（可指定 model / agent） |
| `GET` | `/api/models` | 查詢可用模型列表 |
| `DELETE` | `/api/conversations/:id` | 刪除對話 |
| `GET` | `/api/conversations` | 列出活躍對話 |

**WebSocket API**（JSON-RPC 2.0）：

| 方法 | 說明 |
|------|------|
| `message.send` | 發送訊息，等待 AI 回應 |
| `message.history` | 取得對話歷史 |
| `session.abort` | 中止正在生成的回應 |

---

## 快速開始

### 完整互動範例（curl + WebSocket）

```bash
# 1. 啟動服務
npm run dev

# 2. 查詢可用模型
MODELS=$(curl -s http://127.0.0.1:11697/api/models)
echo "Available models: $MODELS"

# 3. 建立對話並指定預設模型（假設 AgentOrchestrator 監聽在 11697）
CONV=$(curl -s -X POST http://127.0.0.1:11697/api/conversations \
  -H "Content-Type: application/json" \
  -d '{"id":"demo","model":"anthropic/claude-3-5-sonnet","agent":"build"}')

echo "Conversation created: $CONV"

# 4. 使用 WebSocket 發送訊息（需安裝 wscat: npm install -g wscat）
wscat -c ws://127.0.0.1:11697/ws/demo

# 在 wscat 中輸入：
# {"jsonrpc":"2.0","id":1,"method":"message.send","params":{"text":"Hello!"}}
```

### HTML + JavaScript 前端範例

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>AgentOrchestrator Client</title>
</head>
<body>
  <h1>AgentOrchestrator WebSocket Client</h1>
  <div id="log"></div>
  <input id="msg" type="text" placeholder="輸入訊息...">
  <button onclick="send()">發送</button>

  <script>
    async function createConversation() {
      const res = await fetch('http://127.0.0.1:11697/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'web-demo' })
      });
      return res.json();
    }

    let ws;
    async function connect() {
      const conv = await createConversation();
      log('Created: ' + JSON.stringify(conv));

      ws = new WebSocket(conv.wsUrl);
      ws.onopen = () => log('WebSocket connected');
      ws.onmessage = (e) => log('Received: ' + e.data);
      ws.onerror = (e) => log('Error: ' + e.message);
      ws.onclose = () => log('Disconnected');
    }

    function send() {
      const text = document.getElementById('msg').value;
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: Date.now(),
        method: 'message.send', params: { text }
      }));
    }

    function log(msg) {
      document.getElementById('log').innerHTML += '<pre>' + msg + '</pre>';
    }

    connect();
  </script>
</body>
</html>
```

---

## 架構說明

```
[Client / Frontend]
       |
       | HTTP POST /api/conversations
       | GET  /api/models
       v
[AgentOrchestrator HTTP API]  ←── Express (port 0 = auto-allocated)
       |                    |
       | spawn(...)         | spawn("opencode models")
       v                    v
[OpenCode Instance #1]  [Model List]
       |                     |
       | HTTP (internal)     | stdout parse
       v                     v
[OpenCode Server]       [Client Response]

[Client / Frontend]
       |
       | WebSocket /ws/{id}
       v
[AgentOrchestrator WS Router] → forwards to OpenCode Instance #1
```

### 核心模組

| 模組 | 職責 |
|------|------|
| `src/orchestrator/instance-manager.ts` | 管理 OpenCode 實例生命周期（啟動、健康檢查、銷毀、LRU） |
| `src/orchestrator/port-pool.ts` | 動態端口分配與回收 |
| `src/orchestrator/workspace-factory.ts` | 建立 workspace 與 opencode.json 權限設定 |
| `src/opencode-http/client.ts` | 與 OpenCode HTTP API 通訊（含 Basic Auth） |
| `src/opencode-cli/models.ts` | 執行 `opencode models` CLI，解析可用模型列表 |
| `src/websocket/router.ts` | WebSocket 連線路由至對應 OpenCode 實例 |
| `src/websocket/connection.ts` | JSON-RPC 解析、heartbeat、idle timeout |
| `src/config-loader.ts` | 載入 JSON 設定並支援環境變數覆寫 |

---

## 文件連結

| 文件 | 說明 |
|------|------|
| [`docs/API.md`](docs/API.md) | 完整的 REST API 與 WebSocket API 文件，包含請求/回應範例與錯誤處理 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 架構圖、資料流、核心模組詳細說明與 OpenCode 實例生命週期 |
| [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) | 開發環境設定、程式碼規範、提交訊息規範、PR 流程與測試要求 |
| [`CHANGELOG.md`](CHANGELOG.md) | 版本變更記錄 |

---

## 常見問題

### 1. 建立對話時回傳 "OpenCode instance failed health check"

- **原因**：OpenCode 實例未能在指定重試次數內通過健康檢查。
- **排查**：
  - 確認 `opencodeBinary` 路徑正確（`which opencode` 或 `where opencode`）
  - 確認 `portRange` 內的端口未被占用
  - 檢查 OpenCode 日誌（`~/.local/share/opencode/log/`）

### 2. OpenCode CLI 路徑問題

若 `opencode` 不在系統 PATH 中，修改 `config/agentswitch.json`：

```json
"opencodeBinary": "C:\\Users\\<user>\\AppData\\Roaming\\npm\\opencode.cmd"
```

或使用環境變數：

```bash
AGENTSWITCH_ORCHESTRATOR_OPENCODE_BINARY=/usr/local/bin/opencode
```

### 3. 端口被占用

若 `portRange` 內的端口已被其他程式占用：

1. 結束占用端口的程式
2. 或修改 `config/agentswitch.json` 中的 `portRange` 為其他範圍

### 4. 調整權限限制

預設禁止 `external_directory` 與 `bash`。若需放寬特定路徑：

```json
"workspace": {
  "defaultPermissions": {
    "external_directory": { "*": "deny", "C:/Projects/**": "allow" },
    "bash": { "*": "deny", "git *": "allow" }
  }
}
```

參考 [OpenCode 權限文件](https://opencode.ai/docs/zh-tw/permissions/)。

### 5. 如何清理殘留的 workspace

服務正常關機時會自動清理。若異常退出，手動刪除：

```bash
rm -rf workspace/
```

### 6. 如何查詢可用模型

透過 `GET /api/models` 查詢，AgentOrchestrator 會執行 `opencode models` CLI 取得已設定供應商的所有模型：

```bash
curl -s http://127.0.0.1:11697/api/models
```

回傳格式為 `{ id, provider, model }` 陣列。若 OpenCode CLI 未安裝或未設定供應商憑證，回傳空陣列 `[]`。

### 7. 如何為對話設定預設模型

在建立對話時帶入 `model` 與 `agent`：

```bash
curl -s -X POST http://127.0.0.1:11697/api/conversations \
  -H "Content-Type: application/json" \
  -d '{"id":"demo","model":"anthropic/claude-3-5-sonnet","agent":"build"}'
```

之後透過 WebSocket 發送訊息時，若不帶 `model`，會自動使用對話預設模型；若帶 `model`，則覆寫本次請求：

```json
{"jsonrpc":"2.0","id":1,"method":"message.send","params":{"text":"Hello","model":"openai/gpt-5"}}
```

---

## 授權

MIT License
