-- D-669 SHIP 1 — first-inning trouble cache.
-- Source: MLB Stats API /people/{id}/stats?stats=statSplits&group=pitching&sitCodes=i01
-- Probe (2026-06-22): returns 52 stat keys per first-inning split. Verified
-- live on Kevin Gausman (player_id 592332): first-inning ERA=6.00 in 15.0 IP,
-- battersFaced=69, strikeOuts=11, baseOnBalls=6, numberOfPitches=243.
-- Drives score_first_inning_trouble_v2 in scorePitcherOuts (D-668 D7 queued).
-- Refresh: daily 11:30 UTC by new fetch-mlb-pitcher-inn1-daily cron.

CREATE TABLE IF NOT EXISTS public.cache_mlb_pitcher_inn1 (
  player_id        INTEGER     NOT NULL,
  snapshot_date    DATE        NOT NULL,
  inn1_era         NUMERIC(5,2),
  inn1_ip          NUMERIC(5,1),
  inn1_bf          INTEGER,
  inn1_runs        INTEGER,
  inn1_walks       INTEGER,
  inn1_hits        INTEGER,
  inn1_pitches     INTEGER,
  fetched_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (player_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_cmp_inn1_lookup
  ON public.cache_mlb_pitcher_inn1 (player_id, snapshot_date DESC);

ALTER TABLE public.cache_mlb_pitcher_inn1 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inn1_service_all ON public.cache_mlb_pitcher_inn1;
CREATE POLICY inn1_service_all ON public.cache_mlb_pitcher_inn1
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS inn1_authed_read ON public.cache_mlb_pitcher_inn1;
CREATE POLICY inn1_authed_read ON public.cache_mlb_pitcher_inn1
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.cache_mlb_pitcher_inn1 IS
  'D-669 SHIP 1 — first-inning ERA + IP + BF + walks + hits + pitches per SP. Source: MLB Stats API ?stats=statSplits&sitCodes=i01. Daily writer fetch-mlb-pitcher-inn1-daily @ 11:30 UTC.';
