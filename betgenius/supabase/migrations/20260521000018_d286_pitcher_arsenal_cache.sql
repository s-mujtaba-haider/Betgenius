-- D-286 SHIP 2 (2026-05-21) — pitcher arsenal aggregate cache.
--
-- Per-pitcher pitch-type usage percentages from Baseball Savant
-- /leaderboard/pitch-arsenal-stats endpoint. Used by
-- pitcher_pitch_mix_k factor in scorePitcherStrikeouts.
--
-- The Savant endpoint returns one row per (pitcher, pitch_type)
-- with pitch_usage %. Daily refresh via fetch-baseball-savant-weekly
-- extension (D-286 SHIP 2). Aggregator computes breaking_ball_pct
-- (SL + CU + FC + ST + SV) and offspeed_pct (CH + FS) on insert.
--
-- Rollback:
--   DROP TABLE IF EXISTS public.cache_statcast_pitcher_arsenal CASCADE;

CREATE TABLE IF NOT EXISTS public.cache_statcast_pitcher_arsenal (
  player_id INTEGER NOT NULL,
  snapshot_date DATE NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  player_name TEXT,
  total_pitches INTEGER,
  -- Individual pitch-type usage percentages (0-100)
  ff_pct NUMERIC(5,2),   -- 4-Seam Fastball
  si_pct NUMERIC(5,2),   -- Sinker
  fc_pct NUMERIC(5,2),   -- Cutter
  sl_pct NUMERIC(5,2),   -- Slider
  ch_pct NUMERIC(5,2),   -- Changeup
  cu_pct NUMERIC(5,2),   -- Curveball
  fs_pct NUMERIC(5,2),   -- Splitter
  st_pct NUMERIC(5,2),   -- Sweeper
  sv_pct NUMERIC(5,2),   -- Slurve
  kn_pct NUMERIC(5,2),   -- Knuckleball
  -- Derived aggregates (precomputed for fast lookup)
  breaking_ball_pct NUMERIC(5,2),   -- SL + CU + FC + ST + SV
  offspeed_pct NUMERIC(5,2),        -- CH + FS
  PRIMARY KEY (player_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_pitcher_arsenal_pid
  ON public.cache_statcast_pitcher_arsenal (player_id, snapshot_date DESC);

ALTER TABLE public.cache_statcast_pitcher_arsenal ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS arsenal_service_all ON public.cache_statcast_pitcher_arsenal;
CREATE POLICY arsenal_service_all ON public.cache_statcast_pitcher_arsenal
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS arsenal_authenticated_read ON public.cache_statcast_pitcher_arsenal;
CREATE POLICY arsenal_authenticated_read ON public.cache_statcast_pitcher_arsenal
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.cache_statcast_pitcher_arsenal IS
  'D-286 SHIP 2: per-pitcher pitch-arsenal usage % from Baseball Savant '
  '/leaderboard/pitch-arsenal-stats. Refreshed weekly via Sun 4 AM ET cron '
  '(fetch-baseball-savant-weekly D-282 extension). Consumed by '
  'w_mlb_pitcher_pitch_mix_k factor in scorePitcherStrikeouts.';
