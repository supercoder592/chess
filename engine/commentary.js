// 跟 chessai/commentary.py 對應。純粹根據網路自己的評估落差寫講評，
// 不含任何棋理規則。
function generateCommentary(movesSan, evals, userColor, resultText,
                            ratingBefore, ratingAfter, levelInfo) {
  const lines = [];
  lines.push("# 對局講評\n");
  lines.push(`- 結果：${resultText}`);
  if (levelInfo && levelInfo.mode === "pvp") {
    lines.push("- 模式：雙人對戰（AI 只講評、不下棋，不計入棋力）");
    lines.push(`- 使用者執${userColor === "white" ? "白" : "黑"}\n`);
  } else {
    const delta = ratingAfter - ratingBefore;
    lines.push(`- 使用者棋力：${ratingBefore.toFixed(0)} → ${ratingAfter.toFixed(0)}` +
               `（${delta >= 0 ? "+" : ""}${delta.toFixed(1)}）`);
    lines.push(`- AI 這局用的搜尋量：${levelInfo.sims}（第 ${levelInfo.level} 階）\n`);
  }

  const swings = [];
  for (let i = 1; i < evals.length; i++) {
    const moverIsWhite = i % 2 === 1;
    const mover = moverIsWhite ? "white" : "black";
    if (mover !== userColor) continue;
    const rawDelta = evals[i] - evals[i - 1];
    const userDelta = userColor === "white" ? rawDelta : -rawDelta;
    const mv = movesSan[i - 1] || "?";
    swings.push({ ply: i, delta: userDelta, mv });
  }
  const worst = [...swings].sort((a, b) => a.delta - b.delta).slice(0, 3);
  const best = [...swings].sort((a, b) => b.delta - a.delta).slice(0, 3);

  lines.push("## AI 評估對你最不利的幾步\n");
  let shown = false;
  for (const s of worst) {
    if (s.delta < -0.03) { lines.push(`- 第 ${s.ply} 手 \`${s.mv}\`：評估變化 ${s.delta.toFixed(2)}`); shown = true; }
  }
  if (!shown) lines.push("- 沒有評估驟降的手，這盤走得算穩");

  lines.push("\n## AI 評估對你最有利的幾步\n");
  shown = false;
  for (const s of best) {
    if (s.delta > 0.03) { lines.push(`- 第 ${s.ply} 手 \`${s.mv}\`：評估變化 +${s.delta.toFixed(2)}`); shown = true; }
  }
  if (!shown) lines.push("- 這盤沒有明顯的好棋轉折");

  lines.push("\n## 全局評估走勢");
  lines.push("（白方視角，+1 = 白方必勝，-1 = 黑方必勝，每列 10 手）\n");
  lines.push("```");
  for (let i = 0; i < evals.length; i += 10) {
    lines.push(evals.slice(i, i + 10).map((v) => (v >= 0 ? "+" : "") + v.toFixed(2)).join(" "));
  }
  lines.push("```");

  lines.push("\n---");
  lines.push("*這份講評完全來自 AI 自己訓練出的價值網路判斷，沒有任何人寫的棋理規則或開局定式庫。*");
  return lines.join("\n");
}

const CommentaryExports = { generateCommentary };
if (typeof module !== "undefined") module.exports = CommentaryExports;
if (typeof window !== "undefined") window.CommentaryModule = CommentaryExports;
