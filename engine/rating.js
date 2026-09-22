// 跟 chessai/rating.py 對應的 JS 版本:使用者棋力追蹤 + AI 難度階梯。
const LEVELS = [
  [16, 0.7], [24, 0.6], [32, 0.55], [48, 0.5], [64, 0.45],
  [96, 0.4], [129, 0.35], [192, 0.3], [256, 0.25], [384, 0.2],
  [512, 0.15], [768, 0.1], [1024, 0.08],
];
const LEVEL_RATING = LEVELS.map((_, i) => 600 + i * 130);
const K_FACTOR = 32;
const PROMOTE_WINRATE = 0.68;
const DEMOTE_WINRATE = 0.32;
const WINDOW = 5;

class RatingTracker {
  constructor(state) {
    this.state = state || { user_rating: 800.0, level: 0, games: 0, history: [] };
  }

  get level() {
    return Math.min(this.state.level, LEVELS.length - 1);
  }

  currentLevelParams() {
    const lvl = this.level;
    const [sims, temp] = LEVELS[lvl];
    return { level: lvl, sims, temp };
  }

  aiRatingForLevel(lvl) {
    return LEVEL_RATING[Math.min(lvl, LEVEL_RATING.length - 1)];
  }

  recordResult(score, extra) {
    const { level: lvl, sims } = this.currentLevelParams();
    const aiRating = this.aiRatingForLevel(lvl);
    const r = this.state.user_rating;
    const expected = 1.0 / (1.0 + Math.pow(10, (aiRating - r) / 400.0));
    const newR = r + K_FACTOR * (score - expected);

    this.state.games += 1;
    const entry = Object.assign({
      game: this.state.games, t: Date.now() / 1000, result: score,
      level: lvl, sims, ai_rating: aiRating,
      user_rating_before: Math.round(r * 10) / 10,
      user_rating_after: Math.round(newR * 10) / 10,
    }, extra || {});
    this.state.history.push(entry);
    this.state.user_rating = newR;

    const recent = this.state.history.slice(-WINDOW).map((h) => h.result);
    if (recent.length >= 3) {
      const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
      if (avg >= PROMOTE_WINRATE && lvl < LEVELS.length - 1) this.state.level = lvl + 1;
      else if (avg <= DEMOTE_WINRATE && lvl > 0) this.state.level = lvl - 1;
    }
    return newR;
  }

  summary() {
    const { level, sims } = this.currentLevelParams();
    return {
      user_rating: Math.round(this.state.user_rating * 10) / 10,
      games: this.state.games,
      level, level_max: LEVELS.length - 1, next_ai_sims: sims,
    };
  }
}

const RatingExports = { RatingTracker, LEVELS };
if (typeof module !== "undefined") module.exports = RatingExports;
if (typeof window !== "undefined") window.RatingModule = RatingExports;
