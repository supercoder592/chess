// 直接從瀏覽器呼叫 GitHub Contents API 寫檔案 -- 純靜態網頁沒有 git，
// 用這個換掉「git commit/push」，效果一樣：每盤棋自動存回 repo。
// 需要使用者自己的 GitHub Personal Access Token(存在 localStorage，
// 只留在使用者自己的瀏覽器裡，不會送到別的地方)。

const GH_TOKEN_KEY = "chess_practice_gh_token";
const GH_REPO_KEY = "chess_practice_gh_repo"; // "owner/repo"

function getToken() {
  return localStorage.getItem(GH_TOKEN_KEY) || "";
}
function setToken(t) {
  localStorage.setItem(GH_TOKEN_KEY, t);
}
function getRepo() {
  return localStorage.getItem(GH_REPO_KEY) || "";
}
function setRepo(r) {
  localStorage.setItem(GH_REPO_KEY, r);
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
  getToken, setToken, getRepo, setRepo, ghGetFile, ghPutFile,
};
if (typeof module !== "undefined") module.exports = GithubExports;
if (typeof window !== "undefined") window.GithubModule = GithubExports;
