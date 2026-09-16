-- D-349 — pitcher splits vs L/R-handed batters cache.
--
-- Mirrors D-282 cache_mlb_batter_splits pattern. Source: MLB Stats API
-- /people/{id}/stats?stats=statSplits&sitCodes=vl,vr&group=pitching.
-- Sample size (pa_vs_lhb / pa_vs_rhb) used as gate at scorer for ≥30 BF
-- statistical-significance floor.
--
-- Rollback: DROP TABLE IF EXISTS cache_mlb_pitcher_splits CASCADE;

CREATE TABLE IF NOT EXISTS public.cache_mlb_pitcher_splits (
  player_id INTEGER NOT NULL,
  snapshot_date DATE NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  player_name TEXT,
  -- vs LHB
  baa_vs_lhb NUMERIC(5,3),
  obp_vs_lhb NUMERIC(5,3),
  slg_vs_lhb NUMERIC(5,3),
  ops_vs_lhb NUMERIC(5,3),
  pa_vs_lhb INTEGER,
  -- vs RHB
  baa_vs_rhb NUMERIC(5,3),
  obp_vs_rhb NUMERIC(5,3),
  slg_vs_rhb NUMERIC(5,3),
  ops_vs_rhb NUMERIC(5,3),
  pa_vs_rhb INTEGER,
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (player_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_pitcher_splits_pid_date
  ON public.cache_mlb_pitcher_splits (player_id, snapshot_date DESC);

ALTER TABLE public.cache_mlb_pitcher_splits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pitcher_splits_service_all ON public.cache_mlb_pitcher_splits;
CREATE POLICY pitcher_splits_service_all ON public.cache_mlb_pitcher_splits
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS pitcher_splits_authenticated_read ON public.cache_mlb_pitcher_splits;
CREATE POLICY pitcher_splits_authenticated_read ON public.cache_mlb_pitcher_splits
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.cache_mlb_pitcher_splits IS
  'D-349: per-pitcher BAA/OPS vs LHB and RHB. Source: MLB Stats API '
  '/people/{id}/stats?stats=statSplits&sitCodes=vl,vr. Refreshed daily '
  '~05:30 UTC by fetch-mlb-pitcher-splits edge function. Consumed by '
  'w_mlb_pitcher_baa_vs_hand factor in scoreBatterMarket.';
