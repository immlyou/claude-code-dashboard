# Claude Code Dashboard - 專案法典

## 最高指令

1. **有可以程序化的方案就千萬不要自己動手做** - 能自動化就自動化，能腳本化就腳本化
2. **有現成方案就不要自己開發** - 優先使用現有工具、套件、服務，不重複造輪子

## 派工原則

依照任務複雜度分配給適當的模型：

| 任務類型 | 指派模型 | 說明 |
|---------|---------|------|
| 無腦執行 | **Haiku** | 簡單重複、格式轉換、基礎搜尋 |
| 需要思考 | **Sonnet** | 程式開發、問題分析、內容創作 |
| 統籌調度 | **Opus** | 架構設計、複雜決策、多任務協調 |

---

## 專案概述

macOS menu bar app，用於監控 Claude Code CLI sessions 的即時用量。

## 技術架構

- **Electron** + **menubar** - 桌面應用框架
- **Pure JS/CSS** - 無前端框架依賴
- **electron-builder** - 打包 DMG/ZIP

## 重要檔案

| 檔案 | 說明 |
|-----|------|
| `main.js` | Electron 主進程，IPC handlers |
| `preload.js` | Context bridge，暴露 API 給 renderer |
| `collector.js` | 資料收集邏輯，讀取 ~/.claude/ |
| `ui/index.html` | UI 結構 |
| `ui/app.js` | 前端邏輯 |
| `ui/styles.css` | 樣式 |
| `icon-draw.js` | Canvas 繪製 tray icon 動畫 |

## 資料來源

從 `~/.claude/` 讀取：
- `sessions/` - 活躍 CLI sessions
- `projects/` - 對話記錄 (JSONL)
- `settings.json` - Claude Code 設定（含 model）
- `stats-cache.json` - 統計快取

## 開發指令

```bash
npm start          # 開發模式
npm run dist       # 打包 DMG (arm64)
npm run dist:dmg   # 僅 DMG
npm run dist:zip   # 僅 ZIP
```

## 發布流程

1. 更新 `package.json` 版本號
2. 更新 `ui/index.html` 版本顯示
3. Commit & push
4. `git tag vX.X.X && git push origin vX.X.X`
5. GitHub Actions 自動打包並建立 Release
