// 跟 chessai/encoding.py 逐行對應的 JS 版本。
// 差一個位元，AI 看到的棋盤就跟訓練時不一樣，等於在亂下 -- 所以這份
// 刻意寫得囉唆、逐步對照 Python 版本，不耍花招。

const NUM_INPUT_PLANES = 21;
const NUM_MOVE_PLANES = 73;
const POLICY_SIZE = 64 * NUM_MOVE_PLANES; // 4672

// python: chess.PAWN..KING = 1..6，這裡只需要相對順序
const PIECE_ORDER = ["p", "n", "b", "r", "q", "k"];

const QUEEN_DIRS = [
  [0, 1], [1, 1], [1, 0], [1, -1],
  [0, -1], [-1, -1], [-1, 0], [-1, 1],
];
const KNIGHT_DIRS = [
  [1, 2], [2, 1], [2, -1], [1, -2],
  [-1, -2], [-2, -1], [-2, 1], [-1, 2],
];
const UNDER_PIECES = ["n", "b", "r"]; // chess.KNIGHT, BISHOP, ROOK 的順序

function flipSquare(sq) {
  return sq ^ 56;
}
function squareFile(sq) {
  return sq & 7;
}
function squareRank(sq) {
  return sq >> 3;
}
function algebraicToSquare(a) {
  const file = a.charCodeAt(0) - 97; // 'a' = 97
  const rank = a.charCodeAt(1) - 49; // '1' = 49
  return rank * 8 + file;
}

function movePlane(fromSq, toSq, promotion) {
  const ff = squareFile(fromSq), fr = squareRank(fromSq);
  const tf = squareFile(toSq), tr = squareRank(toSq);
  const df = tf - ff, dr = tr - fr;

  if (promotion && promotion !== "q") {
    return 64 + (df + 1) * 3 + UNDER_PIECES.indexOf(promotion);
  }
  for (let i = 0; i < KNIGHT_DIRS.length; i++) {
    if (df === KNIGHT_DIRS[i][0] && dr === KNIGHT_DIRS[i][1]) return 56 + i;
  }
  const dist = Math.max(Math.abs(df), Math.abs(dr));
  const stepF = df === 0 ? 0 : df > 0 ? 1 : -1;
  const stepR = dr === 0 ? 0 : dr > 0 ? 1 : -1;
  let dirIdx = -1;
  for (let i = 0; i < QUEEN_DIRS.length; i++) {
    if (QUEEN_DIRS[i][0] === stepF && QUEEN_DIRS[i][1] === stepR) { dirIdx = i; break; }
  }
  return dirIdx * 7 + (dist - 1);
}

// move: { from: "e2", to: "e4", promotion: "q"|undefined }
function moveToIndex(move, flip) {
  let fromSq = algebraicToSquare(move.from);
  let toSq = algebraicToSquare(move.to);
  if (flip) {
    fromSq = flipSquare(fromSq);
    toSq = flipSquare(toSq);
  }
  return fromSq * NUM_MOVE_PLANES + movePlane(fromSq, toSq, move.promotion);
}

// python-chess 的 board.ep_square 是「只要上一手是兵走兩格就設定」，跟
// FEN 字串裡的欄位不一樣 -- FEN 只有在「真的有合法吃過路兵」才會顯示,
// 但 encode_board 用的是前者(不管能不能吃都設)。用 chess.js 的走棋紀錄
// 自己推算，不能相信 FEN 的 ep 欄位，兩者在很多局面會不一致。
function currentEpSquareAlgebraic(chessInstance) {
  const hist = chessInstance.history({ verbose: true });
  if (hist.length === 0) return null;
  const last = hist[hist.length - 1];
  if (last.piece === "p" && Math.abs(parseInt(last.to[1], 10) - parseInt(last.from[1], 10)) === 2) {
    const file = last.to[0];
    const midRank = (parseInt(last.to[1], 10) + parseInt(last.from[1], 10)) / 2;
    return file + String(midRank);
  }
  return null;
}

// chessInstance: 一個 chess.js 的 Chess() 物件
// 回傳 Float32Array，長度 21*8*8，順序跟 numpy (21,8,8) row-major 一致：
// index = plane*64 + rank*8 + file
function encodeBoard(chessInstance, rep1, rep2) {
  const planes = new Float32Array(NUM_INPUT_PLANES * 64);
  const fen = chessInstance.fen();
  const parts = fen.split(" ");
  const turn = parts[1]; // 'w' or 'b'
  const castling = parts[2];
  const epField = currentEpSquareAlgebraic(chessInstance);
  const halfmove = parseInt(parts[4], 10) || 0;
  const fullmove = parseInt(parts[5], 10) || 1;

  const usWhite = turn === "w";
  const flip = !usWhite; // us == black -> flip

  const board = chessInstance.board(); // board[0] = rank8 ... board[7] = rank1
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const cell = board[row][col];
      if (!cell) continue;
      const rank = 7 - row; // python-chess rank: 0 = rank1
      const file = col;
      const sq = rank * 8 + file;
      const isUs = usWhite ? cell.color === "w" : cell.color === "b";
      const pieceIdx = PIECE_ORDER.indexOf(cell.type);
      const base = isUs ? 0 : 6;
      const s = flip ? flipSquare(sq) : sq;
      const r = squareRank(s), f = squareFile(s);
      planes[(base + pieceIdx) * 64 + r * 8 + f] = 1.0;
    }
  }

  if (rep1) planes.fill(1.0, 12 * 64, 13 * 64);
  if (rep2) planes.fill(1.0, 13 * 64, 14 * 64);

  // castling: 'K','Q','k','q'
  const usK = usWhite ? castling.includes("K") : castling.includes("k");
  const usQ = usWhite ? castling.includes("Q") : castling.includes("q");
  const themK = usWhite ? castling.includes("k") : castling.includes("K");
  const themQ = usWhite ? castling.includes("q") : castling.includes("Q");
  planes.fill(usK ? 1.0 : 0.0, 14 * 64, 15 * 64);
  planes.fill(usQ ? 1.0 : 0.0, 15 * 64, 16 * 64);
  planes.fill(themK ? 1.0 : 0.0, 16 * 64, 17 * 64);
  planes.fill(themQ ? 1.0 : 0.0, 17 * 64, 18 * 64);

  planes.fill(Math.min(halfmove, 100) / 100.0, 18 * 64, 19 * 64);
  planes.fill(Math.min(fullmove, 200) / 200.0, 19 * 64, 20 * 64);

  if (epField) {
    let s = algebraicToSquare(epField);
    if (flip) s = flipSquare(s);
    const r = squareRank(s), f = squareFile(s);
    planes[20 * 64 + r * 8 + f] = 1.0;
  }

  return planes;
}

const EncodingExports = {
  NUM_INPUT_PLANES, NUM_MOVE_PLANES, POLICY_SIZE,
  flipSquare, squareFile, squareRank, algebraicToSquare,
  movePlane, moveToIndex, encodeBoard,
};

if (typeof module !== "undefined") {
  module.exports = EncodingExports;
}
if (typeof window !== "undefined") {
  window.Encoding = EncodingExports;
}
