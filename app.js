// 完全在瀏覽器裡跑的西洋棋 AI 對戰頁面。
// 模型推論(ONNX Runtime Web)、MCTS 搜尋、棋力追蹤全部在本機執行，
// 不需要任何伺服器 -- 手機、電腦、有沒有網路都能玩(第一次載入完模型
// 之後，瀏覽器會快取，離線也能玩；只有「自動記錄回 GitHub」需要網路)。

const PIECE_UNICODE = {
  p: "♙", n: "♘", b: "♗", r: "♖", q: "♕", k: "♔",
};

const LOCAL_RATING_KEY = "chess_practice_rating_state_v1";

let ortSession = null;
let mcts = null;
let game = null;
let historyMap = new Map();
let tracker = null;

let userColor = "white";
let status = "idle";
let movesSan = [];
let evals = [];
let levelInfo = { level: 0, sims: 16 };
let ratingBefore = 800;
let ratingAfter = null;

let selected = null;
let legalFromSel = [];
let pendingPromo = null;
let aiThinking = false;

const boardEl = document.getElementById("board");
const statusLine = document.getElementById("status-line");
const movesLine = document.getElementById("moves-line");
const evalFill = document.getElementById("eval-fill");
const evalText = document.getElementById("eval-text");
const ratingLine = document.getElementById("rating-line");

// ------------------------------------------------------------ model I/O --
async function evaluateOnce(planes) {
  const tensor = new ort.Tensor("float32", planes, [1, 21, 8, 8]);
  const out = await ortSession.run({ input: tensor });
  return { policyLogits: out.policy.data, value: out.value.data[0] };
}

async function quickEval() {
  const planes = Encoding.encodeBoard(game, false, false);
  const { value } = await evaluateOnce(planes);
  return game.turn() === "w" ? value : -value;
}

// ---------------------------------------------------------------- board --
function squareName(file, rank) {
  return "abcdefgh"[file] + (rank + 1);
}

function renderBoard() {
  boardEl.innerHTML = "";
  if (!game) return;
  const board = game.board(); // board[0]=rank8 ... board[7]=rank1
  const flip = userColor === "black";

  for (let visRank = 7; visRank >= 0; visRank--) {
    for (let visFile = 0; visFile < 8; visFile++) {
      const rank = flip ? 7 - visRank : visRank;
      const file = flip ? 7 - visFile : visFile;
      const cell = board[7 - rank][file];
      const name = squareName(file, rank);

      const sq = document.createElement("div");
      sq.className = "sq " + ((file + rank) % 2 === 1 ? "light" : "dark");
      sq.dataset.sq = name;

      if (cell) {
        const span = document.createElement("span");
        span.className = "piece " + (cell.color === "w" ? "white" : "black");
        span.textContent = PIECE_UNICODE[cell.type];
        sq.appendChild(span);
      }
      if (selected === name) sq.classList.add("selected");
      if (legalFromSel.some((m) => m.to === name)) sq.classList.add("target");

      sq.addEventListener("click", () => onSquareClick(name, cell));
      boardEl.appendChild(sq);
    }
  }
}

function updateEval(v) {
  const pct = Math.max(0, Math.min(100, (v + 1) * 50));
  evalFill.style.width = pct + "%";
  evalFill.style.background = v >= 0 ? "#7ec47e" : "#d4756a";
  const lead = v > 0.02 ? "白方" : v < -0.02 ? "黑方" : "均勢";
  evalText.textContent = `評估 ${v.toFixed(2)}（${lead}）`;
}

function refreshUI() {
  renderBoard();
  movesLine.textContent = movesSan.join(" ");
  updateEval(evals.length ? evals[evals.length - 1] : 0);
  ratingLine.textContent = tracker ? tracker.summary().user_rating : "—";

  if (status === "idle") {
    statusLine.textContent = "按下面按鈕開新局";
  } else if (status === "playing") {
    const turnLabel = game.turn() === "w" ? "白方" : "黑方";
    const userTurn = (game.turn() === "w") === (userColor === "white");
    statusLine.textContent = aiThinking ? "AI 思考中…" : userTurn ? "輪到你了" : `輪到 ${turnLabel}`;
  } else if (status === "finished") {
    statusLine.textContent = "對局結束";
  }
}

// ---------------------------------------------------------------- clicks --
function onSquareClick(name, cell) {
  if (!game || status !== "playing" || aiThinking) return;
  const userTurn = (game.turn() === "w") === (userColor === "white");
  if (!userTurn) return;

  if (selected) {
    const target = legalFromSel.find((m) => m.to === name);
    if (target) {
      if (target.promotion) {
        pendingPromo = { from: selected, to: name };
        selected = null;
        legalFromSel = [];
        document.getElementById("promo-overlay").classList.remove("hidden");
        return;
      }
      playUserMove({ from: selected, to: name });
      selected = null;
      legalFromSel = [];
      return;
    }
    selected = null;
    legalFromSel = [];
  }

  const belongsToUser = cell && (userColor === "white" ? cell.color === "w" : cell.color === "b");
  if (belongsToUser) {
    selected = name;
    legalFromSel = game.moves({ square: name, verbose: true });
  }
  refreshUI();
}

document.querySelectorAll(".promo-choices button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.getElementById("promo-overlay").classList.add("hidden");
    if (pendingPromo) {
      playUserMove({ from: pendingPromo.from, to: pendingPromo.to, promotion: btn.dataset.p });
      pendingPromo = null;
    }
  });
});

// ----------------------------------------------------------- game logic --
function transKey() {
  return game.fen().split(" ").slice(0, 4).join(" ");
}
function bumpHistory() {
  const k = transKey();
  historyMap.set(k, (historyMap.get(k) || 0) + 1);
}

// --------------------------------------------------------- 手勢移動動畫 --
function getSquareCenter(name) {
  const el = boardEl.querySelector(`[data-sq="${name}"]`);
  const boardRect = boardEl.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  return {
    x: elRect.left - boardRect.left + elRect.width / 2,
    y: elRect.top - boardRect.top + elRect.height / 2,
  };
}

function animateHandMove(fromSq, toSq, durationMs = 360) {
  const piece = game.get(fromSq);
  return new Promise((resolve) => {
    if (!piece) { resolve(); return; }
    const from = getSquareCenter(fromSq);
    const to = getSquareCenter(toSq);
    const hand = document.createElement("div");
    hand.className = "hand-overlay";
    const colourClass = piece.color === "w" ? "white" : "black";
    hand.innerHTML =
      `<div class="lift-wrap">` +
      `<span class="piece-shadow"></span>` +
      `<span class="hand-piece ${colourClass}">${PIECE_UNICODE[piece.type]}</span>` +
      `<span class="hand-icon">🤏</span>` +
      `</div>`;
    hand.style.left = from.x + "px";
    hand.style.top = from.y + "px";
    boardEl.appendChild(hand);
    void hand.offsetWidth;                // 強制 reflow，讓瀏覽器套用起點位置後才觸發過渡
    hand.style.left = to.x + "px";
    hand.style.top = to.y + "px";
    setTimeout(() => { hand.remove(); resolve(); }, durationMs);
  });
}

async function playUserMove(moveObj) {
  const mv = game.move(moveObj);
  if (!mv) return;
  movesSan.push(mv.san);
  bumpHistory();
  evals.push(await quickEval());
  refreshUI();

  if (await checkGameOver()) return;

  aiThinking = true;
  refreshUI();
  const { sims, temp } = levelInfo;
  const root = await mcts.search(game, historyMap, sims);
  const uci = mcts.pick(root, temp);
  await animateHandMove(uci.slice(0, 2), uci.slice(2, 4));
  const aiMv = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  movesSan.push(aiMv.san);
  bumpHistory();
  evals.push(await quickEval());
  aiThinking = false;
  refreshUI();
  await checkGameOver();
}

async function checkGameOver() {
  if (game.isCheckmate()) {
    const winner = game.turn() === "w" ? "black" : "white"; // side to move is checkmated
    const resultText = `將死，${winner === "black" ? "黑方" : "白方"}獲勝`;
    const userScore = winner === userColor ? 1.0 : 0.0;
    const pgnResult = winner === "black" ? "0-1" : "1-0";
    await finishGame(resultText, userScore, pgnResult);
    return true;
  }
  if (game.isDraw() || game.isStalemate() || game.isThreefoldRepetition()) {
    await finishGame("和棋", 0.5, "1/2-1/2");
    return true;
  }
  return false;
}

async function finishGame(resultText, userScore, pgnResult) {
  status = "finished";
  ratingAfter = tracker.recordResult(userScore, { user_color: userColor, plies: movesSan.length });
  saveTrackerLocal();
  refreshUI();
  showResult(resultText);

  // 把這局需要存檔的資料整個拷貝一份，不要依賴共用的全域變數 --
  // 使用者常常在存檔還沒傳完的時候就點「開新局」，那些全域變數(game,
  // movesSan, evals...)馬上被下一局蓋掉，存檔存到一半接住的就是新局
  // 剛重置的空資料，整個存檔悄悄失敗或存出對不上的內容(這就是「講評
  // 有時候沒跟著存到」的真正原因)。存檔全程只用這份快照，不管使用者
  // 手速多快都不會互相干擾。
  const snapshot = {
    movesSan: movesSan.slice(),
    evals: evals.slice(),
    userColor, levelInfo: { ...levelInfo },
    ratingBefore, ratingAfter,
    resultText, userScore, pgnResult,
  };
  await trySaveToGithub(snapshot);
}

// -------------------------------------------------------------- new game --
async function newGame(color) {
  if (color === "random") color = Math.random() < 0.5 ? "white" : "black";
  userColor = color;
  game = new Chess();
  historyMap = new Map();
  bumpHistory();
  movesSan = [];
  evals = [await quickEval()];
  status = "playing";
  selected = null;
  legalFromSel = [];
  ratingBefore = tracker.state.user_rating;
  ratingAfter = null;
  levelInfo = tracker.currentLevelParams();
  refreshUI();

  if (userColor === "black") {
    aiThinking = true;
    refreshUI();
    const root = await mcts.search(game, historyMap, levelInfo.sims);
    const uci = mcts.pick(root, levelInfo.temp);
    await animateHandMove(uci.slice(0, 2), uci.slice(2, 4));
    const mv = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    movesSan.push(mv.san);
    bumpHistory();
    evals.push(await quickEval());
    aiThinking = false;
    refreshUI();
  }
}

document.getElementById("btn-new-white").addEventListener("click", () => newGame("white"));
document.getElementById("btn-new-black").addEventListener("click", () => newGame("black"));
document.getElementById("btn-new-random").addEventListener("click", () => newGame("random"));
document.getElementById("btn-resign").addEventListener("click", async () => {
  if (status !== "playing" || !confirm("確定要認輸嗎？")) return;
  const loser = userColor;
  const resultText = `${loser === "white" ? "黑方" : "白方"}獲勝（你認輸了）`;
  const pgnResult = loser === "white" ? "0-1" : "1-0";
  await finishGame(resultText, 0.0, pgnResult);
});

function showResult(text) {
  document.getElementById("result-title").textContent = text;
  document.getElementById("result-detail").textContent =
    `棋力：${Math.round(ratingBefore)} → ${Math.round(ratingAfter)}`;
  document.getElementById("result-save-status").textContent = "";
  document.getElementById("result-overlay").classList.remove("hidden");
}
document.getElementById("result-close").addEventListener("click", () => {
  document.getElementById("result-overlay").classList.add("hidden");
});

// ------------------------------------------------------------- rating IO --
function loadTrackerLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_RATING_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}
function saveTrackerLocal() {
  localStorage.setItem(LOCAL_RATING_KEY, JSON.stringify(tracker.state));
}

// ---------------------------------------------------------- GitHub 自動存檔 --
async function ghPutFileRetry(path, content, message, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await GithubModule.ghPutFile(path, content, message);
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw lastErr;
}

// snapshot: finishGame() 存的那份獨立拷貝，全程只用這個，不碰全域變數，
// 使用者手速再快、馬上開新局，也不會弄壞正在傳的這一局。
async function trySaveToGithub(snapshot) {
  const { movesSan, evals, userColor, levelInfo, ratingBefore, ratingAfter,
         resultText, userScore, pgnResult } = snapshot;
  const statusEl = document.getElementById("result-save-status");
  if (!GithubModule.getToken() || !GithubModule.getRepo()) {
    statusEl.textContent = "（沒設定 GitHub，只存在這台裝置）";
    return;
  }
  if (!GithubModule.getRecordEnabled()) {
    statusEl.textContent = "（自動記錄已關閉，這局只存在這台裝置）";
    return;
  }
  statusEl.textContent = "記錄到 GitHub 中…";
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

    // 重播這局自己的棋步，建一個獨立的棋盤只用來產生 PGN，不共用正在
    // 玩的那個 game 物件
    const replay = new Chess();
    replay.header("Event", "西洋棋 AI 練習場",
      "Date", new Date().toISOString().slice(0, 10).replace(/-/g, "."),
      "White", userColor === "white" ? "使用者" : "AI",
      "Black", userColor === "white" ? "AI" : "使用者",
      "Result", pgnResult);
    for (const san of movesSan) replay.move(san);
    const pgn = replay.pgn();

    const commentary = CommentaryModule.generateCommentary(
      movesSan, evals, userColor, resultText, ratingBefore, ratingAfter, levelInfo);

    // PGN 跟講評一起先存，兩個都成功才繼續更新索引 -- 不會出現「有棋譜
    // 沒講評」這種半殘的紀錄
    await ghPutFileRetry(`games/${stamp}.pgn`, pgn, `對局記錄 ${stamp}`);
    await ghPutFileRetry(`games/${stamp}_commentary.md`, commentary, `講評 ${stamp}`);

    const gamesFile = await GithubModule.ghGetFile("data/games.json");
    const games = gamesFile ? JSON.parse(gamesFile.content) : [];
    games.push({
      stamp, date: new Date().toISOString().slice(0, 16).replace("T", " "),
      pgn: `games/${stamp}.pgn`, commentary: `games/${stamp}_commentary.md`,
      result: resultText, user_color: userColor, user_score: userScore,
      plies: movesSan.length, rating_before: ratingBefore, rating_after: ratingAfter,
      level: levelInfo.level, sims: levelInfo.sims, moves_san: movesSan,
    });
    await ghPutFileRetry("data/games.json", JSON.stringify(games, null, 1),
      `對局記錄 ${stamp}（棋力 ${ratingAfter.toFixed(0)}）`);

    await ghPutFileRetry("data/rating.json",
      JSON.stringify({ summary: tracker.summary(), history: tracker.state.history }, null, 1),
      `更新棋力進度（${ratingAfter.toFixed(0)}）`);

    statusEl.textContent = "已記錄到 GitHub";
  } catch (e) {
    console.error(e);
    statusEl.textContent = "記錄失敗（" + e.message + "），但這局分數已存在本機";
  }
}

// ----------------------------------------------------------------- 設定 --
document.getElementById("settings-link").addEventListener("click", (e) => {
  e.preventDefault();
  document.getElementById("input-repo").value = GithubModule.getRepo();
  document.getElementById("input-token").value = GithubModule.getToken();
  document.getElementById("input-record-enabled").checked = GithubModule.getRecordEnabled();
  document.getElementById("settings-overlay").classList.remove("hidden");
});
document.getElementById("settings-close").addEventListener("click", () => {
  document.getElementById("settings-overlay").classList.add("hidden");
});
document.getElementById("settings-save").addEventListener("click", async () => {
  const tokenVal = document.getElementById("input-token").value.trim();
  const repoOk = GithubModule.setRepo(document.getElementById("input-repo").value.trim());
  const tokenOk = GithubModule.setToken(tokenVal);
  GithubModule.setRecordEnabled(document.getElementById("input-record-enabled").checked);

  if (!repoOk || !tokenOk) {
    alert("儲存失敗！這個瀏覽器擋掉了本機儲存功能(可能是隱私/無痕模式，"
         + "或 iOS 的「封鎖所有 Cookie」設定)，設定只能撐到你關掉這個分頁，"
         + "沒辦法長期記住。請檢查瀏覽器的隱私設定。");
    return;
  }

  // 實際打一次 API 驗證 token 真的有效、repo 名稱真的對，不是只存字串
  // 進去就沒事 -- 存對了不代表 token 是對的
  if (tokenVal) {
    try {
      await GithubModule.ghGetFile("README.md");
      alert("已儲存，token 驗證成功可以正常使用。");
    } catch (e) {
      alert("已存進這台裝置，但拿這個 token 呼叫 GitHub 失敗："
           + e.message + "\n請檢查 token 有沒有打對、有沒有勾 repo 權限。");
    }
  }
  updateGithubStatus();
  document.getElementById("settings-overlay").classList.add("hidden");
});

// ------------------------------------------------------------------ init --
// 用網址帶參數快速設定新裝置：開一次
// ?token=xxx&repo=owner/repo 就存進這支裝置的本機，然後把參數從網址
// 列清掉，不會留下痕跡。這個連結本身不會進 git，是使用者自己私下保管
// 的，用來在自己的其他裝置上快速設定，不影響安全性。
//
// 之前這裡存完什麼提示都沒有，存失敗(例如瀏覽器擋掉 localStorage)使用
// 者完全看不出來，以為設定好了其實沒有 -- 現在改成一定會跳出結果。
async function applyUrlSetup() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  const repo = params.get("repo");
  if (!token && !repo) return;

  let ok = true;
  if (token) ok = GithubModule.setToken(token) && ok;
  if (repo) ok = GithubModule.setRepo(repo) && ok;
  const url = new URL(window.location.href);
  url.searchParams.delete("token");
  url.searchParams.delete("repo");
  window.history.replaceState({}, document.title, url.pathname + url.hash);

  if (!ok) {
    alert("設定失敗！這個瀏覽器擋掉了本機儲存功能(可能是隱私/無痕模式，"
         + "或 iOS 的「封鎖所有 Cookie」設定)，token 沒辦法長期記住，"
         + "每次重開都要重新用這個連結設定一次。請檢查瀏覽器的隱私設定，"
         + "或用 Safari 一般模式(不是無痕)打開這個連結。");
    return;
  }
  if (token) {
    try {
      await GithubModule.ghGetFile("README.md");
      alert("設定完成！token 驗證成功，之後這台裝置都會記得，不用再設定。");
    } catch (e) {
      alert("token 已存進這台裝置，但呼叫 GitHub 失敗：" + e.message
           + "\n請確認這串 token 沒有打錯、還沒過期或被撤銷。");
    }
  }
}

function updateGithubStatus() {
  const el = document.getElementById("github-status");
  if (!el) return;
  const hasToken = !!GithubModule.getToken();
  el.textContent = hasToken ? "已設定" : "未設定";
  el.style.color = hasToken ? "#7ec47e" : "#9a9a9a";
}

async function init() {
  await applyUrlSetup();
  updateGithubStatus();
  tracker = new RatingModule.RatingTracker(loadTrackerLocal());
  game = new Chess();
  refreshUI();

  statusLine.textContent = "載入模型中…（第一次會比較久，之後瀏覽器會快取）";
  ortSession = await ort.InferenceSession.create("model.onnx");
  mcts = new MCTS(evaluateOnce);
  evals = [await quickEval()];
  status = "idle";
  refreshUI();
  // 除錯用，方便在瀏覽器主控台檢查狀態，不影響正常使用
  window.__debug = () => ({ game, status, userColor, movesSan, evals, levelInfo });
}

init();
