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

## 相依關係

按上方「相依關係」區塊的「分析」，會讀每個 repo 的 `.gitmodules` 與 `Cargo.toml`，推出誰依賴誰、
各自釘在哪個版本，並算出離上游有多遠。結果會出現在三個地方：

- **一張關係圖**（預設）：直角圓角線，線一律垂直進出、橫移只發生在層與層之間，不會穿過節點。
  **預設只顯示需要注意的相依**（可以升版、釘在別條分支），沒問題的收起來，
  勾「一併顯示沒問題的」才會全部出現。滑到任一節點會只亮跟它相關的線，其餘淡出
- **一張總表**（右上角切換）：依賴方 / 被依賴 / 怎麼引用（submodule 路徑或 crate 名）/ 釘在 / 上游最新 / 狀態
- **每張卡片上兩行**：這個 repo 依賴誰、被誰依賴，以及對方把它釘在哪一版

### 選一個版本，看它綁住的整棵樹

上方的「起點」選 `caliptra-mcu-sw`，版本選單會去問那個 repo 的 **tag 與分支清單**（分兩組列出，
各只花 1 次 API 且會快取），選 `rt-sdk-2.1.0` 或某條 release 分支，按「重新分析」，
會從那個版本往下展開：讀 `raw.githubusercontent.com/<repo>/<那個 tag>/.gitmodules`，
解出它釘住的 caliptra-sw 是哪個 commit，再用那個 commit 去讀 caliptra-sw 的宣告，一路遞迴下去。
節點上顯示的就不再是「上游最新版」，而是**那個版本實際綁到的版本**。

換一個版本再分析，就能比較兩個 release 之間整棵樹差在哪。同一個 repo 在樹裡被綁到兩個不同版本
（例如 `hw/latest` 與 `hw/rev-2_1` 指向不同的 caliptra-ss）也會一起列出來。

起點留在「全部 repo」就是原本的行為：每個 repo 各自看自己 main 上宣告了什麼。

### 隱藏不想看的 repo

「顯示」那一列的每個 repo 名稱都可以點，點掉就從圖和表格裡消失，用來簡化畫面。
選擇會記在瀏覽器裡，下次開還在。

判斷「有沒有落後」分兩種：

- **釘在 tag** 的（韌體引用硬體多半是這種）：拿釘的 tag 跟上游最新的 release 比。
  釘在最新版就標「最新版本」，即使它距離 `main` 有幾百個 commit —— 那是刻意的，不算落後。
- **釘在 commit** 的：用 `compare` 算出離上游幾個 commit。如果 `.gitmodules` 有寫 `branch`，
  就跟那條分支比而不是預設分支（例如 caliptra-ss 釘的是 i3c-core 的 `v1p6`，跟 `main` 比沒有意義）。

`.gitmodules` 與 `Cargo.toml` 是從 `raw.githubusercontent.com` 讀的，**不算 GitHub API 額度**；
只有解析釘住的 commit、tag 清單與落後量會用到 API，大約 25～35 次，所以做成按鈕觸發、結果存在瀏覽器裡。
不想要這個功能就把 `config.js` 的 `analyseDeps` 設成 `false`。

開 DevTools 會看到幾個 404 —— 那是沒有 `.gitmodules` 或 `Cargo.toml` 的 repo，屬於預期內。

## 設定

改 `config.js`：

```js
window.TRACKER_CONFIG = {
  org: 'chipsalliance',        // 自動列舉這個 org 底下的 repo
  keyword: 'caliptra',         // 只留名稱含這個關鍵字的（留空字串代表全部）
  extraRepos: [                // 名稱不含關鍵字、或不在上面 org 的，用 owner/name 補上
    'chipsalliance/adams-bridge',   // caliptra-rtl 的 ML-DSA 加速器
    'chipsalliance/i3c-core',       // caliptra-sw 與 caliptra-ss 都用，兩邊釘不同版本
    'chipsalliance/usb2',           // caliptra-ss 的 USB 2.0 IP
  ],
  excludeRepos: [],            // 不想看到的
  commitsShown: 5,             // 每張卡片列幾筆 commit
  weeks: 8,                    // 活躍度長條圖看幾週
  analyseDeps: true,           // 顯示相依關係區塊
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
| 按一次「分析相依關係」（全部 repo） | 約 25～35（`.gitmodules` 與 `Cargo.toml` 不算） |
| 按一次分析（指定起點與版本） | 約 40～55，樹展得比較深 |

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
