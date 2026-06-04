# 貢獻指南

感謝你對 AgentOrchestrator 的興趣！以下是參與開發的指南。

---

## 開發環境

### 前置需求

- **Node.js** >= 20.0.0（建議使用 [nvm](https://github.com/nvm-sh/nvm) 管理版本）
- **npm** >= 10.0.0
- **OpenCode CLI** 已安裝（`opencode --version`）

### 安裝

```bash
git clone <repository-url>
cd agentswitch
npm install
```

### 常用指令

```bash
# 開發模式（熱重載）
npm run dev

# 編譯 TypeScript
npm run build

# 執行測試
npm test

# 持續監聽測試（開發時使用）
npm run test:watch

# 程式碼檢查
npm run lint

# 自動修復 lint 錯誤
npm run lint:fix

# 格式化程式碼
npx prettier --write src/

# 清理 build 與 workspace
npm run clean
```

---

## 程式碼規範

### ESLint

本專案使用 `typescript-eslint` 進行程式碼檢查。提交前請確保：

```bash
npm run lint
```

**無錯誤、無警告** 才能提交。

### Prettier

格式化設定位於 `.prettierrc`：

- `semi: true`
- `singleQuote: true`
- `tabWidth: 2`
- `trailingComma: "es5"`
- `printWidth: 120`

建議在編輯器中安裝 Prettier 外掛並啟用「儲存時自動格式化」。

### TypeScript

- 啟用 `strict: true`，所有程式碼必須通過型別檢查
- 避免使用 `any`，若必要請加註釋說明
- 介面與型別定義優先使用 `interface`（可擴展性）
- 函式回傳型別盡量明確宣告

---

## 提交訊息規範

遵循 [Conventional Commits](https://www.conventionalcommits.org/) 格式：

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Type 類別

| Type | 說明 |
|------|------|
| `feat` | 新功能 |
| `fix` | 修復 bug |
| `docs` | 文件變更 |
| `style` | 程式碼風格變更（不影響功能） |
| `refactor` | 重構（不新增功能也不修復 bug） |
| `test` | 新增或修改測試 |
| `chore` | 建置流程、輔助工具變更 |

### 範例

```
feat(orchestrator): add model selection per conversation

Support specifying default model and agent when creating a conversation.
The model string is written to workspace/{id}/.opencode/opencode.json.

fix(websocket): resolve model fallback logic in message.send

docs(api): add dedicated API.md for REST and WebSocket endpoints

test(port-pool): add unit tests for allocation and release
```

---

## Pull Request 流程

1. **Fork 儲存庫**（若無直接寫入權限）

2. **建立分支**：
   ```bash
   git checkout -b feat/your-feature-name
   ```

3. **開發與測試**：
   - 確保 `npm run lint` 無錯誤
   - 確保 `npm test` 全部通過
   - 確保 `npm run build` 成功編譯

4. **提交變更**：遵循提交訊息規範

5. **推送並建立 PR**：
   ```bash
   git push origin feat/your-feature-name
   ```
   - PR 標題簡潔描述變更內容
   - PR 描述說明「為什麼」與「做了什麼」
   - 關聯相關 Issue（若有）

6. **Code Review**：
   - 維護者會進行程式碼審查
   - 可能需要修改後重新 push
   - CI 必須通過（lint + test + build）

7. **合併**：審查通過後由維護者合併

---

## 測試要求

### 新增功能

任何新增功能都必須包含：

1. **單元測試**：使用 Vitest，檔案命名 `*.test.ts`
2. **整合測試**（若涉及多個模組交互）：`*.integration.test.ts`

### 測試範例

```ts
// src/orchestrator/port-pool.test.ts
import { describe, it, expect } from 'vitest';
import { PortPool } from './port-pool.js';

describe('PortPool', () => {
  it('should allocate and release ports', () => {
    const pool = new PortPool(30000, 30005);
    const port = pool.allocate();
    expect(port).toBe(30000);
    pool.release(port!);
    expect(pool.getUsedCount()).toBe(0);
  });
});
```

### 測試覆蓋率

建議維持核心模組的測試覆蓋率 > 80%。執行：

```bash
npx vitest run --coverage
```

---

## 文件變更

若變更影響 API 行為，請同時更新：

1. `docs/API.md` — API 詳細說明
2. `README.md` — API 索引與快速開始範例（若適用）
3. `CHANGELOG.md` — 記錄變更（遵循 Keep a Changelog）

---

## 問題回報

發現 bug 或有功能建議？請開啟 Issue 並提供：

- 問題描述
- 重現步驟
- 預期行為 vs 實際行為
- 環境資訊（Node.js 版本、作業系統）
- 相關日誌或截圖

---

## 授權

貢獻即表示你同意你的程式碼將以 [MIT License](../LICENSE) 釋出。
