# chess — 西洋棋練習場

跟 [D:\chess](../chess) 訓練出來的 AI 對戰、練棋的地方。

## 🎮 開始下棋

**https://supercoder592.github.io/chess/**

AI 完全跑在你的瀏覽器裡（ONNX Runtime Web），手機、電腦都能玩，
不需要跟哪台電腦同一個網路，第一次載入模型後瀏覽器會快取，之後開
更快。

- 點格子選子、點目標格走棋
- 「查看紀錄」可以看棋力進度和歷史對局講評
- 想要「自動記錄回 GitHub」的話，點「GitHub 自動記錄設定」，
  填自己的 repo 跟一個有寫入權限的 Personal Access Token
  （只存在你自己的瀏覽器裡）

## 怎麼運作

1. **測棋力**：內部用 Elo 式公式，根據每局結果估你的棋力
2. **逐步加壓**：AI 難度根據最近戰績自動調整，維持接近五五波
3. **賽後講評**：每局結束後，AI 用自己訓練出的價值網路，指出這局
   評估落差最大的幾步 —— 純粹是網路自己的判斷，沒有任何人寫的
   棋理規則
4. **自動記錄**（如果設定了 GitHub token）：每局的 PGN + 講評自動存
   回這個 repo 的 `games/`

## 目錄

- `index.html` / `app.js` / `engine/` — 下棋介面本體，AI 邏輯全部
  在瀏覽器裡跑(MCTS + ONNX 模型推論)
- `model.onnx` — 目前最強模型(從 PyTorch 匯出，給瀏覽器用)
- `model/best_model.pt` — 同一個模型的原始 PyTorch 權重(備份、非
  瀏覽器直接使用)
- `results.html` — 棋力進度 + 歷史對局講評的檢視頁
- `games/` — 每一局的 PGN 棋譜 + 講評
- `data/` — 給網頁用的結構化資料(rating.json / games.json / model.json)

## AI 是誰

完全靠自我對弈學會下棋（AlphaZero 式訓練），沒有人告訴它任何開局
或戰術知識 —— 走的每一步、給的每一句講評，都是它自己從幾千局自我
對弈裡學出來的。
