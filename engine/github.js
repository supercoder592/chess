// 直接從瀏覽器呼叫 GitHub Contents API 寫檔案 -- 純靜態網頁沒有 git，
// 用這個換掉「git commit/push」，效果一樣：每盤棋自動存回 repo。
//
// DEFAULT_TOKEN 是使用者自己要求寫死在這裡的，換取任何裝置打開都不用
// 手動設定。他已經被明確告知：瀏覽器執行的程式碼沒辦法真正保密，任何
// 人打開這個網頁、按 F12 都看得到這串字，這不是這個 repo 公不公開的
// 問題，是瀏覽器本來就沒有「藏起來」這個選項。使用者確認這個帳號被亂
// 寫也沒差，這是他自己承擔的選擇。
// 如果要換掉:去 https://github.com/settings/tokens 撤銷舊的、生新的，
// 改這裡的 DEFAULT_TOKEN，或是使用者自己在設定面板填就會蓋過這個預設值。
const DEFAULT_TOKEN = "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";
const DEFAULT_REPO = "supercoder592/chess";

const GH_TOKEN_KEY = "chess_practice_gh_token";
const GH_REPO_KEY = "chess_practice_gh_repo"; // "owner/repo"
const GH_RECORD_KEY = "chess_practice_gh_record_enabled";

function getToken() {
  return localStorage.getItem(GH_TOKEN_KEY) || DEFAULT_TOKEN;
}
function setToken(t) {
  localStorage.setItem(GH_TOKEN_KEY, t);
}
function getRepo() {
  return localStorage.getItem(GH_REPO_KEY) || DEFAULT_REPO;
}
function setRepo(r) {
  localStorage.setItem(GH_REPO_KEY, r);
}
// 跟有沒有設定 token 分開:想保留 token 但暫時不記錄某幾局的話用這個關掉，
// 不用把 token 刪掉重填。預設開啟(只要有設定 token/repo)。
function getRecordEnabled() {
  const v = localStorage.getItem(GH_RECORD_KEY);
  return v === null ? true : v === "1";
}
function setRecordEnabled(on) {
  localStorage.setItem(GH_RECORD_KEY, on ? "1" : "0");
}

function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function base64ToUtf8(str) {
  return decodeURIComponent(escape(atob(str)));
}

async function ghRequest(path, options) {
  const token = getToken();
  const repo = getRepo();
  if (!token || !repo) throw new Error("尚未設定 GitHub Token / repo");
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      ...(options && options.headers),
    },
  });
  return res;
}

// 讀檔案內容(UTF-8 字串)跟它的 sha，檔案不存在回傳 null
async function ghGetFile(path) {
  const res = await ghRequest(path, { method: "GET" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub 讀取失敗 ${path}: ${res.status}`);
  const data = await res.json();
  return { content: base64ToUtf8(data.content), sha: data.sha };
}

// 寫入(新建或覆蓋)一個檔案
async function ghPutFile(path, content, message) {
  const existing = await ghGetFile(path).catch(() => null);
  const body = {
    message,
    content: utf8ToBase64(content),
    sha: existing ? existing.sha : undefined,
  };
  const res = await ghRequest(path, { method: "PUT", body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub 寫入失敗 ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

const GithubExports = {
  getToken, setToken, getRepo, setRepo,
  getRecordEnabled, setRecordEnabled, ghGetFile, ghPutFile,
};
if (typeof module !== "undefined") module.exports = GithubExports;
if (typeof window !== "undefined") window.GithubModule = GithubExports;
