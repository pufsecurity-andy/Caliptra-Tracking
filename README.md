# Caliptra 更新追蹤

一個純前端的單頁工具，用來追蹤 GitHub 上 Caliptra 相關 repo 的更新狀況：
哪些 repo 動了、動了什麼、哪些是你上次看過之後才出現的。

沒有後端、沒有 build step、沒有相依套件，全部在瀏覽器端呼叫 GitHub REST API。

## 使用方式

**線上版（GitHub Pages）**
1. 把這個分支合併進 `main`
2. repo 的 Settings → Pages → Source 選 `Deploy from a branch`，branch 選 `main` / `(root)`
3. 開 `https://<你的帳號>.github.io/Caliptra-Tracking/`

**本機**
直接用瀏覽器打開 `index.html` 就能用（`file://` 也可以，不需要起 server）。

## 功能

- **手動更新**：按「更新」才會去打 API，資料存在瀏覽器 localStorage，之後開頁面直接看上次的結果
- **未讀標記**：比你上次按「標為已讀」更新的 repo 會有藍點、commit 會標 `NEW`，可以只看有新更新的
- **展開看內容**：點任一列展開，顯示最近的 commit 標題／作者／時間，以及最新的 release
- **顏色標示**：左側色條表示最後更新距今 7 天內（綠）／30 天內（橘）／更久（灰）
- **搜尋與排序**：依最近更新、名稱或 star 數排序
- **深色模式**：預設跟隨系統，也可以手動切換

## 設定

改 `config.js`：

```js
window.TRACKER_CONFIG = {
  org: 'chipsalliance',        // 自動列舉這個 org 底下的 repo
  keyword: 'caliptra',         // 只留名稱含這個關鍵字的（留空字串代表全部）
  extraRepos: [                // 名稱不含關鍵字、或不在上面 org 的，用 owner/name 補上
    'chipsalliance/adams-bridge',
  ],
  excludeRepos: [],            // 不想看到的
  commitsPerRepo: 15,          // 展開時抓幾筆 commit
  freshDays: 7,                // 幾天內算「新鮮」（綠）
  staleDays: 30,               // 超過幾天算「久沒動」（灰）
};
```

因為是自動發現，上游之後開新的 `caliptra-*` repo 會自動出現在清單裡，不用手動維護。

## 關於 API 額度

GitHub API 不帶 token 是 **每小時 60 次**，所以這個頁面刻意設計成省額度：

| 動作 | API 呼叫次數 |
|---|---|
| 按「更新」（拿到所有 repo 的最後更新時間） | 1 |
| 展開一個 repo（commit + release） | 2 |
| 「抓取全部內容」 | 2 × repo 數 |

一般用法一小時內遠遠用不完。如果還是不夠，到「設定」填一個 GitHub Personal Access Token
（在 <https://github.com/settings/tokens> 建立，**不用勾任何 scope**，只讀公開資料就好），
額度會變成 5000 次／小時。

Token 只存在你這台瀏覽器的 localStorage，不會送到 GitHub 以外的任何地方，也不會被 commit 進 repo。
右下角隨時看得到目前剩餘額度。

## 檔案

| 檔案 | 用途 |
|---|---|
| `index.html` | 頁面結構 |
| `app.js` | 全部邏輯：抓取、快取、未讀判斷、渲染 |
| `styles.css` | 樣式（含深色模式） |
| `config.js` | 追蹤清單設定，平常只需要改這個 |
