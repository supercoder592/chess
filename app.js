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
  await trySaveToGithub(resultText, userScore, pgnResult);
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
async function trySaveToGithub(resultText, userScore, pgnResult) {
  const statusEl = document.getElementById("result-save-status");
  if (!GithubModule.getToken() || !GithubModule.getRepo()) {
    statusEl.textContent = "（沒設定 GitHub，只存在這台裝置）";
    return;
  }
  statusEl.textContent = "記錄到 GitHub 中…";
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    game.header("Event", "西洋棋 AI 練習場", "Date", new Date().toISOString().slice(0, 10).replace(/-/g, "."),
      "White", userColor === "white" ? "使用者" : "AI",
      "Black", userColor === "white" ? "AI" : "使用者",
      "Result", pgnResult);
    const pgn = game.pgn();
    const commentary = CommentaryModule.generateCommentary(
      movesSan, evals, userColor, resultText, ratingBefore, ratingAfter, levelInfo);

    await GithubModule.ghPutFile(`games/${stamp}.pgn`, pgn, `對局記錄 ${stamp}`);
    await GithubModule.ghPutFile(`games/${stamp}_commentary.md`, commentary, `講評 ${stamp}`);

    const gamesFile = await GithubModule.ghGetFile("data/games.json");
    const games = gamesFile ? JSON.parse(gamesFile.content) : [];
    games.push({
      stamp, date: new Date().toISOString().slice(0, 16).replace("T", " "),
      pgn: `games/${stamp}.pgn`, commentary: `games/${stamp}_commentary.md`,
      result: resultText, user_color: userColor, user_score: userScore,
      plies: movesSan.length, rating_before: ratingBefore, rating_after: ratingAfter,
      level: levelInfo.level, sims: levelInfo.sims, moves_san: movesSan,
    });
    await GithubModule.ghPutFile("data/games.json", JSON.stringify(games, null, 1),
      `對局記錄 ${stamp}（棋力 ${ratingAfter.toFixed(0)}）`);

    await GithubModule.ghPutFile("data/rating.json",
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
  document.getElementById("settings-overlay").classList.remove("hidden");
});
document.getElementById("settings-close").addEventListener("click", () => {
  document.getElementById("settings-overlay").classList.add("hidden");
});
document.getElementById("settings-save").addEventListener("click", () => {
  GithubModule.setRepo(document.getElementById("input-repo").value.trim());
  GithubModule.setToken(document.getElementById("input-token").value.trim());
  document.getElementById("settings-overlay").classList.add("hidden");
});

// ------------------------------------------------------------------ init --
async function init() {
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
