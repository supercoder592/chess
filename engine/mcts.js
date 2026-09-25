// 瀏覽器版 PUCT MCTS。跟 chessai/mcts.py 一樣是「批次 + virtual loss」：
// 一次選出 BATCH 個葉節點，一起丟給網路算，ONNX Runtime 的呼叫次數少
// 好幾倍 -- 對小網路來說每次呼叫的固定開銷才是大頭，所以這樣快很多，
// 搜尋次數完全一樣。virtual loss 讓同一批裡的路徑彼此避開。
// 在 Web Worker 裡跑，主畫面不會被卡住。

const C_PUCT = 1.8;
const FPU = 0.25;
const BATCH = 8;

class Node {
  constructor(prior) {
    this.prior = prior || 0;
    this.visits = 0;
    this.valueSum = 0;
    this.vloss = 0;
    this.children = null; // Map<uci, {node, move}> | null(未展開)
  }
  get q() {
    return this.visits === 0 ? 0 : this.valueSum / this.visits;
  }
}

function transKey(game) {
  // 跟 python 的 board._transposition_key() 類似:局面+誰走+易位權+
  // 過路兵，不含步數計數器
  return game.fen().split(" ").slice(0, 4).join(" ");
}

function terminalValue(game, rep) {
  if (game.isCheckmate()) return -1.0;
  const halfmove = parseInt(game.fen().split(" ")[4], 10) || 0;
  if (game.isStalemate() || game.isInsufficientMaterial() || halfmove >= 100 || rep >= 3) {
    return 0.0;
  }
  return null;
}

class MCTS {
  // evaluateBatch: async (Float32Array[] planesList) -> { policies: Float32Array[], values: number[] }
  constructor(evaluateBatch, batchSize) {
    this.evaluateBatch = evaluateBatch;
    this.batchSize = batchSize || BATCH;
  }

  expand(node, moves, flip, policyLogits) {
    if (moves.length === 0) {
      node.children = new Map();
      return;
    }
    const idxs = moves.map((m) => Encoding.moveToIndex(m, flip));
    const logits = idxs.map((i) => policyLogits[i]);
    const maxLogit = Math.max(...logits);
    const exps = logits.map((l) => Math.exp(l - maxLogit));
    const sum = exps.reduce((a, b) => a + b, 0);
    node.children = new Map();
    moves.forEach((m, i) => {
      const uci = m.from + m.to + (m.promotion || "");
      node.children.set(uci, { node: new Node(exps[i] / sum), move: m });
    });
  }

  select(game, root, historyMap) {
    const path = [root];
    const counts = new Map();
    let node = root;
    let steps = 0;
    while (node.children !== null && node.children.size > 0) {
      const sqrtTotal = Math.sqrt(Math.max(node.visits + node.vloss, 1));
      const parentQ = node.q;
      let bestUci = null, best = null, bestScore = -Infinity;
      for (const [uci, entry] of node.children) {
        const child = entry.node;
        const n = child.visits + child.vloss;
        const q = n > 0 ? -child.q : -parentQ - FPU;
        const score = q + C_PUCT * child.prior * sqrtTotal / (1 + n);
        if (score > bestScore) {
          bestScore = score;
          bestUci = uci;
          best = entry;
        }
      }
      game.move({ from: bestUci.slice(0, 2), to: bestUci.slice(2, 4), promotion: bestUci[4] });
      steps++;
      const key = transKey(game);
      counts.set(key, (counts.get(key) || 0) + 1);
      node = best.node;
      path.push(node);
    }
    for (const n of path) n.vloss += 1;
    const key = transKey(game);
    const rep = (historyMap.get(key) || 0) + (counts.get(key) || 0);
    return { path, rep, steps };
  }

  backup(path, value) {
    let v = value;
    for (let k = path.length - 1; k >= 0; k--) {
      path[k].vloss -= 1;
      path[k].visits += 1;
      path[k].valueSum += v;
      v = -v;
    }
  }

  async search(game, historyMap, simulations) {
    const root = new Node();
    const rootRep = historyMap.get(transKey(game)) || 0;
    const rootPlanes = Encoding.encodeBoard(game, rootRep >= 1, rootRep >= 2);
    const first = await this.evaluateBatch([rootPlanes]);
    this.expand(root, game.moves({ verbose: true }), game.turn() === "b", first.policies[0]);
    root.vloss += 1;
    this.backup([root], first.values[0]);

    while (root.visits < simulations) {
      const want = Math.min(this.batchSize, simulations - root.visits);
      const pending = [], paths = [], leafMoves = [], leafFlips = [];
      for (let i = 0; i < want; i++) {
        const { path, rep, steps } = this.select(game, root, historyMap);
        const leaf = path[path.length - 1];
        if (leaf.children !== null) {
          // 已經展開過但沒有子節點 = 終局節點，重算它的終局價值
          this.backup(path, terminalValue(game, rep) || 0.0);
        } else {
          const tv = terminalValue(game, rep);
          if (tv !== null) {
            leaf.children = new Map();
            this.backup(path, tv);
          } else {
            pending.push(Encoding.encodeBoard(game, rep >= 1, rep >= 2));
            paths.push(path);
            leafMoves.push(game.moves({ verbose: true }));
            leafFlips.push(game.turn() === "b");
          }
        }
        for (let k = 0; k < steps; k++) game.undo();
      }
      if (pending.length === 0) continue;
      const { policies, values } = await this.evaluateBatch(pending);
      for (let i = 0; i < pending.length; i++) {
        this.expand(paths[i][paths[i].length - 1], leafMoves[i], leafFlips[i], policies[i]);
        this.backup(paths[i], values[i]);
      }
    }
    return root;
  }

  visitPolicy(root) {
    const entries = [...root.children.entries()];
    const visits = entries.map(([, e]) => e.node.visits);
    const total = visits.reduce((a, b) => a + b, 0);
    const probs = total === 0
      ? (() => {
          const priors = entries.map(([, e]) => e.node.prior);
          const s = priors.reduce((a, b) => a + b, 0) || 1;
          return priors.map((p) => p / s);
        })()
      : visits.map((v) => v / total);
    return { ucis: entries.map(([u]) => u), probs };
  }

  pick(root, temperature) {
    const { ucis, probs } = this.visitPolicy(root);
    if (temperature <= 1e-3) {
      let bi = 0;
      for (let i = 1; i < probs.length; i++) if (probs[i] > probs[bi]) bi = i;
      return ucis[bi];
    }
    const p = probs.map((x) => Math.pow(x, 1 / temperature));
    const s = p.reduce((a, b) => a + b, 0);
    const norm = p.map((x) => x / s);
    let r = Math.random(), acc = 0;
    for (let i = 0; i < norm.length; i++) {
      acc += norm[i];
      if (r <= acc) return ucis[i];
    }
    return ucis[ucis.length - 1];
  }
}

const MCTSExports = { MCTS, Node, transKey, terminalValue };
if (typeof module !== "undefined") {
  module.exports = MCTSExports;
}
globalThis.MCTSModule = MCTSExports;
