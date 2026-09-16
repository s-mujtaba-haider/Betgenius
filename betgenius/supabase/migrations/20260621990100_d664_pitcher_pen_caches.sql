-- D-664 SHIP 1 (C) — 3 new caches for SP last-3-form / pen-rest / back-of-bullpen.
-- Source: MLB Stats API ?stats=gameLog + active roster + season pitching stats.
-- Writer: NEW daily cron edge fn fetch-mlb-pitcher-pen-extras-daily (11:00 UTC).
-- Reader: process-games-mlb readTeamSeasonContext / fetchPitcherSeasonAsOpposing.
-- All consumers gracefully degrade to null on cache miss.

-- ============================================================
-- 1) cache_mlb_pitcher_last3 — last-3-start aggregate ERA per SP.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.cache_mlb_pitcher_last3 (
  player_id      INTEGER     NOT NULL,
  snapshot_date  DATE        NOT NULL,
  last3_era      NUMERIC(5,2),
  last3_ip       NUMERIC(5,1),
  last3_starts   INTEGER,
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (player_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_cmpl3_lookup
  ON public.cache_mlb_pitcher_last3 (player_id, snapshot_date DESC);

ALTER TABLE public.cache_mlb_pitcher_last3 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pitcher_last3_service_all ON public.cache_mlb_pitcher_last3;
CREATE POLICY pitcher_last3_service_all ON public.cache_mlb_pitcher_last3
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS pitcher_last3_authed_read ON public.cache_mlb_pitcher_last3;
CREATE POLICY pitcher_last3_authed_read ON public.cache_mlb_pitcher_last3
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.cache_mlb_pitcher_last3 IS
  'D-664 — last-3-start aggregate ERA per SP. Source: MLB Stats API /people/{id}/stats?stats=gameLog. Daily writer fetch-mlb-pitcher-pen-extras 11:00 UTC.';

-- ============================================================
-- 2) cache_mlb_pen_rest — team-level relief IP over the L48h window.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.cache_mlb_pen_rest (
  team_id        INTEGER     NOT NULL,
  team_name      TEXT,
  snapshot_date  DATE        NOT NULL,
  pen_ip_48h     NUMERIC(5,1),
  games_in_48h   INTEGER,
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_cmpr_team_name
  ON public.cache_mlb_pen_rest (team_name, snapshot_date DESC);

ALTER TABLE public.cache_mlb_pen_rest ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pen_rest_service_all ON public.cache_mlb_pen_rest;
CREATE POLICY pen_rest_service_all ON public.cache_mlb_pen_rest
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS pen_rest_authed_read ON public.cache_mlb_pen_rest;
CREATE POLICY pen_rest_authed_read ON public.cache_mlb_pen_rest
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.cache_mlb_pen_rest IS
  'D-664 — team relief-IP over last 48h. Source: MLB Stats API /teams/{id}/stats?stats=byDateRange&group=pitching. Daily writer fetch-mlb-pitcher-pen-extras 11:00 UTC.';

-- ============================================================
-- 3) cache_mlb_bullpen_high_leverage — per-team avg ERA across HL arms.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.cache_mlb_bullpen_high_leverage (
  team_id        INTEGER     NOT NULL,
  team_name      TEXT,
  snapshot_date  DATE        NOT NULL,
  hl_arm_count   INTEGER,
  hl_avg_era     NUMERIC(5,2),
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_cmbhl_team_name
  ON public.cache_mlb_bullpen_high_leverage (team_name, snapshot_date DESC);

ALTER TABLE public.cache_mlb_bullpen_high_leverage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bullpen_hl_service_all ON public.cache_mlb_bullpen_high_leverage;
CREATE POLICY bullpen_hl_service_all ON public.cache_mlb_bullpen_high_leverage
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS bullpen_hl_authed_read ON public.cache_mlb_bullpen_high_leverage;
CREATE POLICY bullpen_hl_authed_read ON public.cache_mlb_bullpen_high_leverage
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.cache_mlb_bullpen_high_leverage IS
  'D-664 — avg ERA across high-leverage relievers (saveOpps >= 5 OR holds >= 10) per team. Source: MLB Stats API roster + per-pitcher season stats. Daily writer fetch-mlb-pitcher-pen-extras 11:00 UTC.';
