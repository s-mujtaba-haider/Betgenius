-- D-824 — batter contact-rate / whiff-rate factor for hits.
-- The hits-specific discriminator (the "pull_rate equivalent" for hits — D-822 MEDIUM gap).
-- High contact + low whiff → favor OVER (more balls in play = more hits).
-- Source: Baseball Savant custom leaderboard CSV (whiff_percent + contact %).
--
-- CRITICAL — snapshot_date in PK: lesson from D-820. pull_rate / sprint_speed
-- were structurally un-backfillable because their tables had no per-day history.
-- This table captures snapshot_date as part of the PK so the D-825 retune can
-- read the AS-OF row strictly < pick.game_date (same D-801 leak-safe pattern
-- that worked for xwoba/launch/sweet/hard_hit).
CREATE TABLE IF NOT EXISTS cache_statcast_batters_contact_rate (
  player_id INTEGER NOT NULL,
  snapshot_date DATE NOT NULL,
  year INTEGER NOT NULL,
  player_name TEXT,
  whiff_percent NUMERIC,
  contact_percent NUMERIC,
  swing_percent NUMERIC,
  oz_swing_percent NUMERIC,
  z_contact_percent NUMERIC,
  oz_contact_percent NUMERIC,
  k_percent NUMERIC,
  bb_percent NUMERIC,
  inserted_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (player_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_d824_contact_rate_player ON cache_statcast_batters_contact_rate (player_id, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_d824_contact_rate_snapshot ON cache_statcast_batters_contact_rate (snapshot_date);

-- 4 new pick_history columns for storage proof (D-758 guard checks).
ALTER TABLE pick_history ADD COLUMN IF NOT EXISTS score_batter_contact_rate NUMERIC;
ALTER TABLE pick_history ADD COLUMN IF NOT EXISTS batter_whiff_pct NUMERIC;
ALTER TABLE pick_history ADD COLUMN IF NOT EXISTS batter_contact_pct NUMERIC;
ALTER TABLE pick_history ADD COLUMN IF NOT EXISTS batter_z_contact_pct NUMERIC;

-- algorithm_weights row (w_mlb_batter_contact_rate) handled separately via
-- §19.3 AskUserQuestion gate per Cardinal Rule #3 — see D-818 pattern.
--
-- D-726-style integrity invariants.
ALTER TABLE cache_statcast_batters_contact_rate
  ADD CONSTRAINT d824_whiff_pct_sane
  CHECK (whiff_percent IS NULL OR (whiff_percent >= 0 AND whiff_percent <= 100));
ALTER TABLE cache_statcast_batters_contact_rate
  ADD CONSTRAINT d824_contact_pct_sane
  CHECK (contact_percent IS NULL OR (contact_percent >= 0 AND contact_percent <= 100));
ALTER TABLE cache_statcast_batters_contact_rate
  ADD CONSTRAINT d824_z_contact_pct_sane
  CHECK (z_contact_percent IS NULL OR (z_contact_percent >= 0 AND z_contact_percent <= 100));
ALTER TABLE cache_statcast_batters_contact_rate
  ADD CONSTRAINT d824_oz_contact_pct_sane
  CHECK (oz_contact_percent IS NULL OR (oz_contact_percent >= 0 AND oz_contact_percent <= 100));
