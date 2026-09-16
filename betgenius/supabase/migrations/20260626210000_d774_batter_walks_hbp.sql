-- D-774 — Add batter walks + HBP for opp-discipline factor reconstruction.
-- D-773 found that opp_walk_rate / opp_obp_patience couldn't reconstruct from
-- 2025 cohort because fetch-mlb-boxscores never captured bat.baseOnBalls or
-- bat.hitByPitch. Add the columns; re-backfill fills them.

ALTER TABLE cache_mlb_boxscore_player_stats
  ADD COLUMN IF NOT EXISTS batter_walks INTEGER,
  ADD COLUMN IF NOT EXISTS batter_hbp   INTEGER,
  ADD COLUMN IF NOT EXISTS batter_sac_flies INTEGER;

ALTER TABLE cache_mlb_boxscore_player_stats
  DROP CONSTRAINT IF EXISTS d774_walks_sane,
  DROP CONSTRAINT IF EXISTS d774_hbp_sane;
ALTER TABLE cache_mlb_boxscore_player_stats
  ADD CONSTRAINT d774_walks_sane CHECK (batter_walks IS NULL OR (batter_walks >= 0 AND batter_walks <= 10)),
  ADD CONSTRAINT d774_hbp_sane CHECK (batter_hbp IS NULL OR (batter_hbp >= 0 AND batter_hbp <= 5));
