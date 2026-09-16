-- D-669 SHIP 2 — team chase rate cache.
-- Source: Baseball Savant /leaderboard/custom?selections=oz_swing_percent
-- Probe (2026-06-22): 533 player rows at min=10, 430 at min=50. Real
-- oz_swing_percent (= chase = out-of-zone swing %) data. League avg ~30%.
-- Sample: Burleson 33.8, Harris II 44.9, Beavers 23.9, Cortes 23.6.
-- Team level NOT exposed directly — aggregated via roster + groupby
-- inside writer. Drives score_opp_chase_rate_v2 in scorePitcherOuts.
-- Refresh: weekly by new fetch-savant-team-chase-weekly cron.

CREATE TABLE IF NOT EXISTS public.cache_savant_team_chase (
  team_id          INTEGER     NOT NULL,
  team_name        TEXT,
  snapshot_date    DATE        NOT NULL,
  oz_swing_avg     NUMERIC(5,2),
  z_swing_avg      NUMERIC(5,2),
  n_players        INTEGER,
  fetched_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_cstc_team_name
  ON public.cache_savant_team_chase (team_name, snapshot_date DESC);

ALTER TABLE public.cache_savant_team_chase ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chase_service_all ON public.cache_savant_team_chase;
CREATE POLICY chase_service_all ON public.cache_savant_team_chase
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS chase_authed_read ON public.cache_savant_team_chase;
CREATE POLICY chase_authed_read ON public.cache_savant_team_chase
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.cache_savant_team_chase IS
  'D-669 SHIP 2 — team-aggregate chase rate (out-of-zone swing %) from Baseball Savant /leaderboard/custom selection=oz_swing_percent. Aggregated by roster lookup. Weekly refresh.';
