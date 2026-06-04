# test: complete Phase 1 test coverage

## Summary

補齊 Phase 1 最後三個核心模組的單元測試，使專案測試覆蓋率趨於完整。新增 30 個測試，總測試數達到 69 個。

## Changes

### 1. `src/opencode-http/client.test.ts`（11 個測試）
- Mock `global.fetch` 進行無網路呼叫的 HTTP 測試
- 驗證 GET/POST/DELETE 方法與 query string 構建
- 驗證 Basic Auth header 生成（有/無憑證）
- 測試 HTTP 4xx/5xx 錯誤處理與網路失敗
- 測試 AbortSignal 傳遞與 204 No Content 回傳

### 2. `src/websocket/connection.test.ts`（11 個測試）
- Mock WebSocket 為純事件觸發器，隔離測試
- JSON-RPC request dispatch 與 result/error 回應
- Parse error (-32700) 與 Invalid Request (-32600)
- Handler exception 映射為 -32000 錯誤
- send/sendEvent 受 readyState 控制
- Heartbeat timeout 導致 terminate()
- Pong 重置 alive flag 與 idle timer
- Idle timeout 關閉連線

### 3. `src/http-api/server.test.ts`（9 個測試）
- 使用 supertest 測試 Express endpoint
- Mock InstanceManager 進行隔離測試
- 覆蓋 GET /health, POST/DELETE/GET /api/conversations
- 測試 CORS headers 與 OPTIONS preflight
- 測試 500 錯誤回應

### 4. 安裝 supertest
- `npm install --save-dev supertest @types/supertest`

## 測試結果

```
Test Files  8 passed (8)
     Tests  69 passed (69)
```

## Phase 1 測試覆蓋總結

| 模組 | 測試數 | 狀態 |
|------|--------|------|
| config-loader | 1 | ✅ |
| port-pool | 3 | ✅ |
| logger | 7 | ✅ |
| workspace-factory | 8 | ✅ |
| instance-manager | 19 | ✅ |
| opencode-http/client | 11 | ✅ |
| websocket/connection | 11 | ✅ |
| http-api/server | 9 | ✅ |
| **總計** | **69** | ✅ |

## 檢查清單

- [x] `npm run lint` passes
- [x] `npm run test` passes (69/69)
- [x] `npm run build` compiles
- [x] `npm run preflight` works
- [x] 新增 30 個單元測試
- [x] 遵循 Conventional Commits
