-- D-283 SHIP 4 (2026-05-21) — bullpen aggregates cache.
--
-- Per-team relief-pitcher aggregate stats from MLB Stats API
-- /teams/{teamId}/stats?stats=statSplits&group=pitching&sitCodes=rp.
-- Used by bullpen_quality factor in scoreBatterMarket +
-- scoreGameTotal. Late-AB context: starters typically exit by
-- inning 6; bullpen quality drives the remaining 9-12 AB outcomes.
--
-- Daily refresh via 5 AM ET cron (D-283 migration 11 pattern).
--
-- Rollback:
--   DROP TABLE IF EXISTS public.cache_mlb_bullpen_stats CASCADE;

CREATE TABLE IF NOT EXISTS public.cache_mlb_bullpen_stats (
  team_id INTEGER NOT NULL,
  team_abbrev TEXT,
  team_name TEXT,
  snapshot_date DATE NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  bullpen_era NUMERIC(5,2),
  bullpen_whip NUMERIC(5,3),
  bullpen_ip NUMERIC(7,1),
  bullpen_k_per_9 NUMERIC(5,2),
  bullpen_bb_per_9 NUMERIC(5,2),
  bullpen_baa NUMERIC(5,3),
  PRIMARY KEY (team_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_cache_mlb_bullpen_stats_team_abbrev
  ON public.cache_mlb_bullpen_stats (team_abbrev, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS idx_cache_mlb_bullpen_stats_team_name
  ON public.cache_mlb_bullpen_stats (team_name, snapshot_date DESC);

ALTER TABLE public.cache_mlb_bullpen_stats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bullpen_service_all ON public.cache_mlb_bullpen_stats;
CREATE POLICY bullpen_service_all ON public.cache_mlb_bullpen_stats
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS bullpen_authenticated_read ON public.cache_mlb_bullpen_stats;
CREATE POLICY bullpen_authenticated_read ON public.cache_mlb_bullpen_stats
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.cache_mlb_bullpen_stats IS
  'D-283 SHIP 4: per-team relief-pitcher aggregates from MLB Stats '
  'API statSplits + sitCodes=rp. Refreshed daily via 5 AM ET cron. '
  'Consumed by w_mlb_bullpen_quality factor in scoreBatterMarket + '
  'scoreGameTotal.';
