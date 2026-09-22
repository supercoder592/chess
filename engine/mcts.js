// 瀏覽器版 PUCT MCTS。跟 chessai/mcts.py 的邏輯對應，但因為瀏覽器是
// 單執行緒、ONNX Runtime Web 呼叫是非同步的，這裡用序列(一次一個
// 模擬)而不是批次 -- 犧牲一點速度換取程式碼簡單、好對照驗證正確性。
// 不含 virtual loss(那是給平行批次用的，序列模擬用不到)。

const C_PUCT = 1.8;
const FPU = 0.25;

class Node {
  constructor(prior) {
    this.prior = prior || 0;
    this.visits = 0;
    this.valueSum = 0;
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
  constructor(evaluate) {
    this.evaluate = evaluate; // async (Float32Array planes) -> {policyLogits, value}
  }

  expand(node, game, policyLogits) {
    const moves = game.moves({ verbose: true });
    if (moves.length === 0) {
      node.children = new Map();
      return;
    }
    const flip = game.turn() === "b";
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

  selectChild(node) {
    const sqrtTotal = Math.sqrt(Math.max(node.visits, 1));
    const parentQ = node.q;
    let bestUci = null, bestChild = null, bestScore = -Infinity;
    for (const [uci, entry] of node.children) {
      const child = entry.node;
      const n = child.visits;
      const q = n > 0 ? -child.q : -parentQ - FPU;
      const score = q + C_PUCT * child.prior * sqrtTotal / (1 + n);
      if (score > bestScore) {
        bestScore = score;
        bestUci = uci;
        bestChild = entry;
      }
    }
    return { uci: bestUci, entry: bestChild };
  }

  async search(game, historyMap, simulations) {
    const rootKey = transKey(game);
    const rootRep = historyMap.get(rootKey) || 0;
    const planes = Encoding.encodeBoard(game, rootRep >= 1, rootRep >= 2);
    const { policyLogits, value } = await this.evaluate(planes);
    const root = new Node();
    this.expand(root, game, policyLogits);
    root.visits = 1;
    root.valueSum = value;

    for (let i = 0; i < simulations; i++) {
      const path = [root];
      const localCounts = new Map();
      let node = root;
      let steps = 0;

      while (node.children !== null && node.children.size > 0) {
        const { uci, entry } = this.selectChild(node);
        if (!entry) break;
        game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
        const key = transKey(game);
        localCounts.set(key, (localCounts.get(key) || 0) + 1);
        node = entry.node;
        path.push(node);
        steps++;
      }

      const key = transKey(game);
      const rep = (historyMap.get(key) || 0) + (localCounts.get(key) || 0);
      let leafValue;
      if (node.children !== null) {
        // 已經展開過但沒有子節點 = 終局節點，重算它的終局價值
        leafValue = terminalValue(game, rep) || 0.0;
      } else {
        const tv = terminalValue(game, rep);
        if (tv !== null) {
          node.children = new Map();
          leafValue = tv;
        } else {
          const leafPlanes = Encoding.encodeBoard(game, rep >= 1, rep >= 2);
          const res = await this.evaluate(leafPlanes);
          this.expand(node, game, res.policyLogits);
          leafValue = res.value;
        }
      }

      let v = leafValue;
      for (let k = path.length - 1; k >= 0; k--) {
        path[k].visits += 1;
        path[k].valueSum += v;
        v = -v;
      }
      for (let k = 0; k < steps; k++) game.undo();
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

if (typeof module !== "undefined") {
  module.exports = { MCTS, Node, transKey, terminalValue };
}
