// AI 引擎 Web Worker：模型推論 + MCTS 都在這裡跑，主畫面只負責畫棋盤，
// 所以 AI 思考的時候畫面不會凍住。
import { Chess } from "https://cdn.jsdelivr.net/npm/chess.js@1.0.0/dist/esm/chess.js";
import * as ort from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.min.mjs";
import "./encoding.js";
import "./mcts.js";

ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/";

let session = null;
let mcts = null;

async function evaluateBatch(planesList) {
  const B = planesList.length;
  const per = planesList[0].length;
  const buf = new Float32Array(B * per);
  planesList.forEach((p, i) => buf.set(p, i * per));
  const out = await session.run({ input: new ort.Tensor("float32", buf, [B, 21, 8, 8]) });
  const P = out.policy.data.length / B;
  const policies = [];
  for (let i = 0; i < B; i++) policies.push(out.policy.data.subarray(i * P, (i + 1) * P));
  return { policies, values: Array.from(out.value.data) };
}

// 從開局重放整串棋步：走法編碼要靠真實的歷史(例如過路兵)，不能只靠 FEN
function rebuild(moves) {
  const game = new Chess();
  const hist = new Map();
  const bump = () => {
    const k = MCTSModule.transKey(game);
    hist.set(k, (hist.get(k) || 0) + 1);
  };
  bump();
  for (const u of moves) {
    game.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
    bump();
  }
  return { game, hist };
}

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    if (type === "init") {
      session = await ort.InferenceSession.create(e.data.modelUrl, {
        executionProviders: e.data.ep || ["wasm"],
      });
      mcts = new MCTSModule.MCTS(evaluateBatch, e.data.batch);
      self.postMessage({ id, ok: true, simd: ort.env.wasm.simd, threads: ort.env.wasm.numThreads });
    } else if (type === "eval") {
      const { game } = rebuild(e.data.moves);
      const planes = Encoding.encodeBoard(game, false, false);
      const { values } = await evaluateBatch([planes]);
      const v = values[0];
      self.postMessage({ id, ok: true, value: game.turn() === "w" ? v : -v });
    } else if (type === "search") {
      const { game, hist } = rebuild(e.data.moves);
      const root = await mcts.search(game, hist, e.data.sims);
      self.postMessage({ id, ok: true, uci: mcts.pick(root, e.data.temp) });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.stack) || err) });
  }
};
