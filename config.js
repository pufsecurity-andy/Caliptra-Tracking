/* 追蹤設定：改這個檔案就好，不用動 app.js。 */
window.TRACKER_CONFIG = {
  // 自動發現：列出這個 org 底下名稱含 keyword 的 repo
  org: 'chipsalliance',
  keyword: 'caliptra',

  // 手動補充：名稱不含 keyword、或不在上面 org 的 repo，用 owner/name 格式
  extraRepos: [
    'chipsalliance/adams-bridge',
  ],

  // 不想看到的 repo（owner/name 或只寫 name 都可以）
  excludeRepos: [],

  // 展開一個 repo 時要抓幾筆 commit
  commitsPerRepo: 15,

  // 幾天內算「近期有更新」（影響顏色標示）
  freshDays: 7,
  staleDays: 30,
};
