-- D-293 (2026-05-23) — historical context warehouses for D-294 algo replay.
--
-- 7 warehouses across 7 SHIPS:
--   1. cache_mlb_historical_weather (Open-Meteo archive, $0)
--   2. cache_mlb_historical_bullpen (derived from outcomes via rolling-14d)
--   3. cache_mlb_historical_lineups (extracted from boxscore endpoint)
--   4. cache_mlb_historical_splits (MLB Stats API season-to-date)
--   5. cache_mlb_historical_batter_statcast (Baseball Savant season tables)
--      cache_mlb_historical_pitcher_statcast (same)
--   6. cache_mlb_historical_arsenal (Savant pitch-arsenal-stats per season)
--      cache_mlb_historical_framing (Savant catcher-framing per season; latest-snapshot proxy if blocked)
--
-- Per Cardinal §1.20 honest fallback policy: splits + statcast + arsenal/framing
-- use season-to-date proxy (most-recent in-season snapshot) when point-in-time
-- not available. Replay fidelity tier documented in framework §7.Y.
--
-- All tables RLS-enabled (service_role full, authenticated read).
--
-- Rollback:
--   DROP TABLE IF EXISTS cache_mlb_historical_weather, cache_mlb_historical_bullpen,
--     cache_mlb_historical_lineups, cache_mlb_historical_splits,
--     cache_mlb_historical_batter_statcast, cache_mlb_historical_pitcher_statcast,
--     cache_mlb_historical_arsenal, cache_mlb_historical_framing CASCADE;

-- SHIP 1 — weather
CREATE TABLE IF NOT EXISTS public.cache_mlb_historical_weather (
  event_id TEXT PRIMARY KEY,
  commence_time TIMESTAMPTZ NOT NULL,
  venue_name TEXT,
  lat NUMERIC, lon NUMERIC,
  temperature_f NUMERIC,
  wind_speed_mph NUMERIC,
  wind_direction_degrees INTEGER,
  precipitation_mm NUMERIC,
  humidity_pct NUMERIC,
  is_dome BOOLEAN NOT NULL DEFAULT FALSE,
  source TEXT NOT NULL DEFAULT 'open-meteo',
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hist_weather_commence ON public.cache_mlb_historical_weather (commence_time);

-- SHIP 2 — bullpen (rolling-14d per team per date)
CREATE TABLE IF NOT EXISTS public.cache_mlb_historical_bullpen (
  team_name TEXT NOT NULL,
  snapshot_date DATE NOT NULL,
  rolling_14d_era NUMERIC,
  rolling_14d_whip NUMERIC,
  rolling_14d_ip NUMERIC,
  rolling_14d_k_per_9 NUMERIC,
  rolling_14d_bb_per_9 NUMERIC,
  games_in_window INTEGER,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_name, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_hist_bullpen_date ON public.cache_mlb_historical_bullpen (snapshot_date);

-- SHIP 3 — lineups
CREATE TABLE IF NOT EXISTS public.cache_mlb_historical_lineups (
  event_id TEXT NOT NULL,
  team_side TEXT NOT NULL CHECK (team_side IN ('home','away')),
  lineup_position INTEGER NOT NULL,
  player_id INTEGER,
  player_name TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, team_side, lineup_position)
);
CREATE INDEX IF NOT EXISTS idx_hist_lineups_event ON public.cache_mlb_historical_lineups (event_id);

-- SHIP 4 — batter splits (season-to-date proxy)
CREATE TABLE IF NOT EXISTS public.cache_mlb_historical_splits (
  player_id INTEGER NOT NULL,
  season INTEGER NOT NULL,
  player_name TEXT,
  vs_lhp_avg NUMERIC, vs_lhp_obp NUMERIC, vs_lhp_slg NUMERIC, vs_lhp_ops NUMERIC,
  vs_lhp_pa INTEGER, vs_lhp_hits INTEGER, vs_lhp_tb INTEGER, vs_lhp_hr INTEGER, vs_lhp_rbi INTEGER,
  vs_rhp_avg NUMERIC, vs_rhp_obp NUMERIC, vs_rhp_slg NUMERIC, vs_rhp_ops NUMERIC,
  vs_rhp_pa INTEGER, vs_rhp_hits INTEGER, vs_rhp_tb INTEGER, vs_rhp_hr INTEGER, vs_rhp_rbi INTEGER,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, season)
);
CREATE INDEX IF NOT EXISTS idx_hist_splits_season ON public.cache_mlb_historical_splits (season);

-- SHIP 5a — batter Statcast (season aggregates)
CREATE TABLE IF NOT EXISTS public.cache_mlb_historical_batter_statcast (
  player_id INTEGER NOT NULL,
  season INTEGER NOT NULL,
  player_name TEXT,
  babip NUMERIC, xba NUMERIC, xslg NUMERIC, xwoba NUMERIC,
  barrel_rate NUMERIC, barrel_pa_rate NUMERIC, hard_hit_pct NUMERIC,
  exit_velo_avg NUMERIC, exit_velo_max NUMERIC,
  launch_angle_avg NUMERIC, sweet_spot_pct NUMERIC,
  pa INTEGER,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, season)
);
CREATE INDEX IF NOT EXISTS idx_hist_bat_sc_season ON public.cache_mlb_historical_batter_statcast (season);

-- SHIP 5b — pitcher Statcast (season aggregates)
CREATE TABLE IF NOT EXISTS public.cache_mlb_historical_pitcher_statcast (
  player_id INTEGER NOT NULL,
  season INTEGER NOT NULL,
  player_name TEXT,
  xera NUMERIC, era NUMERIC, babip_allowed NUMERIC, xba_allowed NUMERIC,
  barrel_rate_allowed NUMERIC, hard_hit_pct_allowed NUMERIC,
  fly_ball_rate NUMERIC, hr_per_9 NUMERIC, k_per_9 NUMERIC, bb_per_9 NUMERIC,
  ip NUMERIC,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, season)
);
CREATE INDEX IF NOT EXISTS idx_hist_pit_sc_season ON public.cache_mlb_historical_pitcher_statcast (season);

-- SHIP 6a — pitcher arsenal (season aggregates)
CREATE TABLE IF NOT EXISTS public.cache_mlb_historical_arsenal (
  player_id INTEGER NOT NULL,
  season INTEGER NOT NULL,
  player_name TEXT,
  total_pitches INTEGER,
  ff_pct NUMERIC, si_pct NUMERIC, fc_pct NUMERIC,
  sl_pct NUMERIC, ch_pct NUMERIC, cu_pct NUMERIC,
  fs_pct NUMERIC, st_pct NUMERIC, sv_pct NUMERIC, kn_pct NUMERIC,
  breaking_ball_pct NUMERIC, offspeed_pct NUMERIC,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, season)
);
CREATE INDEX IF NOT EXISTS idx_hist_arsenal_season ON public.cache_mlb_historical_arsenal (season);

-- SHIP 6b — catcher framing (season aggregates)
CREATE TABLE IF NOT EXISTS public.cache_mlb_historical_framing (
  player_id INTEGER NOT NULL,
  season INTEGER NOT NULL,
  player_name TEXT,
  pitches INTEGER,
  rv_tot NUMERIC,
  pct_tot NUMERIC,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, season)
);
CREATE INDEX IF NOT EXISTS idx_hist_framing_season ON public.cache_mlb_historical_framing (season);

-- RLS for all 8 tables
DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'cache_mlb_historical_weather','cache_mlb_historical_bullpen','cache_mlb_historical_lineups',
    'cache_mlb_historical_splits','cache_mlb_historical_batter_statcast','cache_mlb_historical_pitcher_statcast',
    'cache_mlb_historical_arsenal','cache_mlb_historical_framing'
  ]) LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_service_all', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)', t||'_service_all', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_auth_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)', t||'_auth_read', t);
  END LOOP;
END $$;

COMMENT ON TABLE public.cache_mlb_historical_weather IS 'D-293 SHIP 1: Open-Meteo historical archive per event';
COMMENT ON TABLE public.cache_mlb_historical_bullpen IS 'D-293 SHIP 2: rolling-14d bullpen ERA derived from outcomes';
COMMENT ON TABLE public.cache_mlb_historical_lineups IS 'D-293 SHIP 3: per-event starting lineup from MLB Stats API boxscore';
COMMENT ON TABLE public.cache_mlb_historical_splits IS 'D-293 SHIP 4: per-player per-season splits (season-to-date proxy)';
COMMENT ON TABLE public.cache_mlb_historical_batter_statcast IS 'D-293 SHIP 5a: per-batter per-season Statcast aggregates (season-to-date)';
COMMENT ON TABLE public.cache_mlb_historical_pitcher_statcast IS 'D-293 SHIP 5b: per-pitcher per-season Statcast aggregates (season-to-date)';
COMMENT ON TABLE public.cache_mlb_historical_arsenal IS 'D-293 SHIP 6a: per-pitcher per-season pitch arsenal usage % (season-to-date)';
COMMENT ON TABLE public.cache_mlb_historical_framing IS 'D-293 SHIP 6b: per-catcher per-season framing rv_tot (season-to-date)';
