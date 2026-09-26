// 棋盤畫格子的共用邏輯。下棋主頁(可點)、查看紀錄頁的回放(唯讀)都共用
// 這一份，不要各自複製一次 -- 之前就是同一段邏輯散落在兩個檔案裡，
// 改一邊忘了改另一邊才會出狀況。
const PIECE_UNICODE = {
  p: "♙", n: "♘", b: "♗", r: "♖", q: "♕", k: "♔",
};

// 棋子用 SVG 圖(cburnett 棋子組)，不用 Unicode 字元：手機上字元會被當成
// emoji 畫出來、CSS 顏色失效，黑白兩邊看起來一樣
function pieceImageUrl(color, type) {
  return `pieces/${color}${type.toUpperCase()}.svg`;
}

let _pieceImages = null;
function loadPieceImages() {
  if (_pieceImages) return _pieceImages;
  _pieceImages = Promise.all(
    ["w", "b"].flatMap((c) => ["p", "n", "b", "r", "q", "k"].map((t) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve([c + t, img]);
      img.onerror = () => resolve([c + t, null]);
      img.src = pieceImageUrl(c, t);
    })))
  ).then((pairs) => Object.fromEntries(pairs));
  return _pieceImages;
}

function squareName(file, rank) {
  return "abcdefgh"[file] + (rank + 1);
}

function renderPieces(el, boardArray, flip, opts) {
  opts = opts || {};
  el.innerHTML = "";
  for (let visRank = 7; visRank >= 0; visRank--) {
    for (let visFile = 0; visFile < 8; visFile++) {
      const rank = flip ? 7 - visRank : visRank;
      const file = flip ? 7 - visFile : visFile;
      const cell = boardArray[7 - rank][file];
      const name = squareName(file, rank);

      const sq = document.createElement("div");
      sq.className = "sq " + ((file + rank) % 2 === 1 ? "light" : "dark");
      sq.dataset.sq = name;

      if (cell) {
        const span = document.createElement("span");
        span.className = "piece " + (cell.color === "w" ? "white" : "black");
        span.style.backgroundImage = `url(${pieceImageUrl(cell.color, cell.type)})`;
        sq.appendChild(span);
      }
      if (opts.selected === name) sq.classList.add("selected");
      if (opts.targets && opts.targets.some((m) => m.to === name)) sq.classList.add("target");
      if (opts.onClick) sq.addEventListener("click", () => opts.onClick(name, cell));
      el.appendChild(sq);
    }
  }
}

function buildPositions(Chess, movesSan) {
  const b = new Chess();
  const positions = [b.board()];
  for (const san of movesSan) {
    b.move(san);
    positions.push(b.board());
  }
  return positions;
}

const LIGHT_SQ = "#e9dcc3";
const DARK_SQ = "#7d6a54";

function drawPositionToCanvas(canvas, boardArray, flip, sq, images) {
  const ctx = canvas.getContext("2d");
  ctx.font = `${Math.floor(sq * 0.72)}px "Segoe UI Symbol", "Apple Color Emoji", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let visRank = 7; visRank >= 0; visRank--) {
    for (let visFile = 0; visFile < 8; visFile++) {
      const rank = flip ? 7 - visRank : visRank;
      const file = flip ? 7 - visFile : visFile;
      const x = visFile * sq, y = (7 - visRank) * sq;
      const light = (file + rank) % 2 === 1;
      ctx.fillStyle = light ? LIGHT_SQ : DARK_SQ;
      ctx.fillRect(x, y, sq, sq);
      const cell = boardArray[7 - rank][file];
      const img = cell && images ? images[cell.color + cell.type] : null;
      if (img) {
        ctx.drawImage(img, x + sq * 0.05, y + sq * 0.05, sq * 0.9, sq * 0.9);
      } else if (cell) {
        ctx.fillStyle = cell.color === "w" ? "#ffffff" : "#000000";
        ctx.strokeStyle = cell.color === "w" ? "#000000" : "#dddddd";
        ctx.lineWidth = 2;
        const g = PIECE_UNICODE[cell.type];
        ctx.strokeText(g, x + sq / 2, y + sq / 2 + sq * 0.03);
        ctx.fillText(g, x + sq / 2, y + sq / 2 + sq * 0.03);
      }
    }
  }
}

const BoardRender = {
  PIECE_UNICODE, pieceImageUrl, loadPieceImages, squareName, renderPieces, buildPositions,
  drawPositionToCanvas,
};
if (typeof module !== "undefined") module.exports = BoardRender;
if (typeof window !== "undefined") window.BoardRender = BoardRender;
