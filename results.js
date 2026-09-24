async function loadJSON(path) {
  try {
    const res = await fetch(path + "?t=" + Date.now());
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

function resultClass(score) {
  if (score === 1) return "result-win";
  if (score === 0) return "result-loss";
  return "result-draw";
}

function resultLabel(score) {
  if (score === 1) return "贏";
  if (score === 0) return "輸";
  return "和";
}

async function loadModel() {
  const data = await loadJSON("data/model.json");
  const desc = document.getElementById("model-desc");
  const updated = document.getElementById("model-updated");
  if (!data) {
    desc.textContent = "還沒有紀錄";
    return;
  }
  desc.textContent = data.description;
  updated.textContent = "更新時間：" + data.updated_at;
}

function drawRatingChart(history) {
  const canvas = document.getElementById("rating-chart");
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 320;
  const h = 140;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  if (!history || history.length === 0) {
    ctx.fillStyle = "#9a9a9a";
    ctx.font = "14px sans-serif";
    ctx.fillText("還沒有對局紀錄", 10, h / 2);
    return;
  }

  const values = history.map((h2) => h2.user_rating_after);
  const min = Math.min(...values) - 20;
  const max = Math.max(...values) + 20;
  const pad = 10;
  const stepX = (w - pad * 2) / Math.max(1, values.length - 1);

  ctx.strokeStyle = "#5fb3d4";
  ctx.lineWidth = 2;
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = pad + i * stepX;
    const y = h - pad - ((v - min) / (max - min)) * (h - pad * 2);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.fillStyle = "#5fb3d4";
  values.forEach((v, i) => {
    const x = pad + i * stepX;
    const y = h - pad - ((v - min) / (max - min)) * (h - pad * 2);
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  });
}

async function loadRating() {
  const data = await loadJSON("data/rating.json");
  if (!data) return;
  const s = data.summary;
  document.getElementById("rating-value").textContent = s.user_rating;
  document.getElementById("rating-games").textContent = s.games;
  document.getElementById("rating-level").textContent = s.level + " / " + s.level_max;
  drawRatingChart(data.history);
  window.addEventListener("resize", () => drawRatingChart(data.history));
}

function openOverlay(html) {
  document.getElementById("overlay-body").innerHTML = html;
  document.getElementById("overlay").classList.remove("hidden");
}

function closeOverlay() {
  document.getElementById("overlay").classList.add("hidden");
}

function simpleMarkdownToHtml(md) {
  const escaped = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const lines = escaped.split("\n");
  let html = "";
  let inCode = false;
  for (const line of lines) {
    if (line.startsWith("```")) {
      inCode = !inCode;
      html += inCode ? "<pre>" : "</pre>";
      continue;
    }
    if (inCode) {
      html += line + "\n";
      continue;
    }
    if (line.startsWith("# ")) html += `<h1>${line.slice(2)}</h1>`;
    else if (line.startsWith("## ")) html += `<h2>${line.slice(3)}</h2>`;
    else if (line.startsWith("- ")) html += `<p>• ${line.slice(2)}</p>`;
    else if (line.trim() === "---") html += "<hr>";
    else if (line.trim() === "") html += "";
    else html += `<p>${line}</p>`;
  }
  return html;
}

async function showGame(game) {
  openOverlay("<p class='muted'>載入講評中…</p>");
  try {
    const res = await fetch(game.commentary + "?t=" + Date.now());
    const md = res.ok ? await res.text() : "（沒有講評）";
    const movesHtml =
      "<h2>棋譜</h2><p class='small muted'>" +
      game.moves_san.join(" ") +
      "</p>";
    openOverlay(simpleMarkdownToHtml(md) + movesHtml);
  } catch (e) {
    openOverlay("<p>載入失敗</p>");
  }
}

async function deleteGame(g) {
  if (!GithubModule.getToken() || !GithubModule.getRepo()) {
    alert("沒有設定 GitHub token，沒辦法刪除雲端上的紀錄");
    return;
  }
  if (!confirm(`確定要刪除這局紀錄嗎？（${g.date}）這個動作沒辦法復原。`)) return;

  try {
    await GithubModule.ghDeleteFile(g.pgn, `刪除對局 ${g.stamp}`);
    await GithubModule.ghDeleteFile(g.commentary, `刪除講評 ${g.stamp}`);

    const gamesFile = await GithubModule.ghGetFile("data/games.json");
    const games = gamesFile ? JSON.parse(gamesFile.content) : [];
    const kept = games.filter((x) => x.stamp !== g.stamp);
    await GithubModule.ghPutFile("data/games.json", JSON.stringify(kept, null, 1),
      `刪除對局 ${g.stamp}`);

    await loadGames();
  } catch (e) {
    alert("刪除失敗：" + e.message);
  }
}

async function loadGames() {
  const games = await loadJSON("data/games.json");
  const list = document.getElementById("games-list");
  if (!games || games.length === 0) {
    list.innerHTML = "<p class='muted'>還沒有對局紀錄</p>";
    return;
  }
  list.innerHTML = "";
  games
    .slice()
    .reverse()
    .forEach((g) => {
      const el = document.createElement("div");
      el.className = "game-item";
      const colorLabel = g.user_color === "white" ? "執白" : "執黑";
      el.innerHTML = `
        <div class="game-top">
          <span class="${resultClass(g.user_score)}">${resultLabel(g.user_score)}</span>
          <span class="game-date">${g.date}</span>
          <button class="delete-btn" title="刪除這局">🗑</button>
        </div>
        <div class="game-meta">
          ${colorLabel} · ${g.plies} 手 · 難度階 ${g.level}
          · 棋力 ${Math.round(g.rating_before)} → ${Math.round(g.rating_after)}
        </div>
      `;
      el.addEventListener("click", () => showGame(g));
      el.querySelector(".delete-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        deleteGame(g);
      });
      list.appendChild(el);
    });
}

document.getElementById("overlay-close").addEventListener("click", closeOverlay);
document.getElementById("overlay").addEventListener("click", (e) => {
  if (e.target.id === "overlay") closeOverlay();
});

loadModel();
loadRating();
loadGames();
