# Caliptra 更新儀表板

一頁看完 GitHub 上所有 Caliptra 相關 repo 的更新狀況：誰動了、動了什麼、哪些是你上次看過之後才出現的。
所有內容直接攤在頁面上，不用點開任何東西。

純前端、沒有後端、沒有 build step、沒有相依套件，全部在瀏覽器端呼叫 GitHub REST API。

## 使用方式

**線上版（GitHub Pages）**
1. 把這個分支合併進 `main`
2. repo 的 Settings → Pages → Source 選 `Deploy from a branch`，branch 選 `main` / `(root)`
3. 開 `https://<你的帳號>.github.io/Caliptra-Tracking/`

**本機**
直接用瀏覽器打開 `index.html` 就能用（`file://` 也可以，不需要起 server）。

## 頁面上有什麼

**上方四塊統計**：近 7 天的 commit 總數、自上次查看以來的新 commit 數、7 天內有更新的 repo 數、剛發新 release 的 repo 數。

**每個 repo 一張卡片**，卡片上直接顯示：

- repo 名稱與說明，右側是最後更新時間；左側色條表示 7 天內（綠）／30 天內（黃）／更久（灰）
- **最新版本**：最新的 release tag 與發佈時間，底下列出更早的幾個版本。沒有發 release 的 repo 會退而顯示最新的 tag
- 近 8 週每週 commit 數的長條圖，本週那格顏色較深，旁邊是這段期間的 commit 總數
- **最近 5 筆 commit 標題**（可按「顯示其餘 N 筆」在頁面內展開到 40 筆），比你上次查看更新的會標 `NEW`

**點任何一筆 commit**，右側會滑出面板，在頁面裡直接顯示：

- 完整的 commit 訊息（不只標題，包含說明內文）
- 改了哪些檔案、各自的 +/− 行數與新增／修改／刪除
- **每個檔案的實際 diff**，加減行有底色，預設展開前兩個檔案

**點任何一個版本號**，同一個面板會顯示那個版本的完整 release notes（Markdown 會轉成排版，連結可點）。

不需要跳去 GitHub 就能判斷這次改動有沒有影響到你。每筆 commit 的內容抓過就存在瀏覽器裡，再開不用重抓。

**搜尋框搜的是 repo 名稱、說明與 commit 訊息全文**，例如打 `ML-DSA` 就只留下提過它的 repo。

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
  commitsShown: 5,             // 每張卡片列幾筆 commit
  weeks: 8,                    // 活躍度長條圖看幾週
  showReleases: true,          // 顯示最新 release（每個 repo 多花 1 次 API）
  freshDays: 7,                // 幾天內算「近期有更新」（綠）
  staleDays: 30,               // 超過幾天算「久沒動」（灰）
};
```

因為是自動發現，上游之後開新的 `caliptra-*` repo 會自動出現，不用手動維護清單。

## 關於 API 額度

GitHub API 不帶 token 是 **每小時 60 次**。這個儀表板要顯示所有 repo 的更新內容，所以第一次會花比較多，
之後靠兩個機制壓下來：**只重抓 `pushed_at` 有變的 repo**，以及**跳過已封存的 repo**（勾選「顯示已封存」時才補抓）。

| 情況 | API 呼叫次數 |
|---|---|
| 第一次抓（8 個 repo） | 1 + 8 × 2 = 17（沒發 release 的 repo 會多 1 次抓 tag） |
| 之後按「更新」，其中 2 個有新 commit | 1 + 2 × 2 = 5 |
| 之後按「更新」，都沒動 | 1 |
| 重新整理頁面（讀快取） | 0 |
| 點開一筆沒看過的 commit 看 diff | 1（之後再開同一筆是 0） |

右下角隨時看得到剩餘額度。如果不夠用，到「設定」填一個 GitHub Personal Access Token
（在 <https://github.com/settings/tokens> 建立，**不用勾任何 scope**），額度會變成 5000 次／小時。
Token 只存在你這台瀏覽器的 localStorage，不會送到 GitHub 以外的任何地方，也不會被 commit 進 repo。

常看 diff 的話建議直接填 token——一筆 commit 一次呼叫，沒有 token 很快就會用完。

## 檔案

| 檔案 | 用途 |
|---|---|
| `index.html` | 頁面結構 |
| `app.js` | 全部邏輯：抓取、快取、未讀判斷、活躍度長條圖、diff 與 release notes 呈現 |
| `styles.css` | 樣式（含深色模式） |
| `config.js` | 追蹤清單設定，平常只需要改這個 |
