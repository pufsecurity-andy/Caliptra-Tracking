/* 追蹤設定：改這個檔案就好，不用動 app.js。 */
window.TRACKER_CONFIG = {
  // 自動發現：列出這個 org 底下名稱含 keyword 的 repo
  org: 'chipsalliance',
  keyword: 'caliptra',

  // 手動補充：名稱不含 keyword、或不在上面 org 的 repo，用 owner/name 格式。
  // 這幾個是實際被 submodule 引用、但名字不含 caliptra 的相依。
  extraRepos: [
    'chipsalliance/adams-bridge',   // caliptra-rtl 的 ML-DSA 加速器
    'chipsalliance/i3c-core',       // caliptra-sw 與 caliptra-ss 都用，兩邊釘不同版本
    'chipsalliance/usb2',           // caliptra-ss 的 USB 2.0 IP
  ],

  // 不想看到的 repo（owner/name 或只寫 name 都可以）
  excludeRepos: [],

  // 每張卡片先列幾筆 commit（其餘按「顯示全部」在頁面內展開）
  commitsShown: 5,

  // 版本區塊列出最近幾個 release
  releasesShown: 4,

  // 活躍度長條圖要看幾週
  weeks: 8,

  // 相依分析：從各 repo 的 .gitmodules 與 Cargo.toml 推出誰依賴誰、釘在哪一版。
  // .gitmodules / Cargo.toml 是從 raw.githubusercontent.com 讀的，不算 API 額度；
  // 但解析釘住的 commit、tag 與落後量需要打 API，所以做成按鈕觸發、結果會快取。
  analyseDeps: true,

  // 幾天內算「近期有更新」（影響狀態顏色）
  freshDays: 7,
  staleDays: 30,
};
