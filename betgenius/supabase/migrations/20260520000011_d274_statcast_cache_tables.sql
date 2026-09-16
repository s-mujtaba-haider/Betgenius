-- D-274 Phase 0 (2026-05-20) — Statcast cache tables.
--
-- Daily snapshot ingestion from Baseball Savant CSV leaderboards.
-- Append-daily pattern (PRIMARY KEY on (player_id, snapshot_date))
-- so we can reconstruct point-in-time state for backtest scoring.
--
-- Real limitation: Baseball Savant CSV endpoints only serve
-- season-to-date leaderboards as-of-today — there is no historical
-- date parameter. Backfill for D-274 will write today's snapshot
-- to today's date; historical pick scoring (May 17-20) uses today's
-- snapshot as best-available proxy. D-275 with The Odds API
-- historical endpoint provides the path to real point-in-time
-- scoring.
--
-- Rollback:
--   DROP TABLE public.cache_statcast_batters_xstats CASCADE;
--   DROP TABLE public.cache_statcast_batters_exit_velo CASCADE;
--   DROP TABLE public.cache_statcast_pitchers_xstats CASCADE;
--   DROP TABLE public.cache_statcast_pitchers_exit_velo CASCADE;

-- Batter expected stats (regression indicators: actual vs expected)
CREATE TABLE IF NOT EXISTS public.cache_statcast_batters_xstats (
  player_id                bigint NOT NULL,
  snapshot_date            date NOT NULL,
  player_name              text,
  pa                       integer,
  bip                      integer,
  ba                       numeric,
  est_ba                   numeric,
  est_ba_minus_ba_diff     numeric,
  slg                      numeric,
  est_slg                  numeric,
  est_slg_minus_slg_diff   numeric,
  woba                     numeric,
  est_woba                 numeric,
  est_woba_minus_woba_diff numeric,
  created_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, snapshot_date)
);

-- Batter exit velocity + barrels
CREATE TABLE IF NOT EXISTS public.cache_statcast_batters_exit_velo (
  player_id               bigint NOT NULL,
  snapshot_date           date NOT NULL,
  player_name             text,
  attempts                integer,
  avg_hit_angle           numeric,
  anglesweetspotpercent   numeric,
  max_hit_speed           numeric,
  avg_hit_speed           numeric,
  ev95plus                integer,
  ev95percent             numeric,
  barrels                 integer,
  brl_percent             numeric,
  brl_pa                  numeric,
  created_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, snapshot_date)
);

-- Pitcher expected stats allowed (regression to mean indicator)
CREATE TABLE IF NOT EXISTS public.cache_statcast_pitchers_xstats (
  player_id                bigint NOT NULL,
  snapshot_date            date NOT NULL,
  player_name              text,
  pa                       integer,
  bip                      integer,
  ba                       numeric,
  est_ba                   numeric,
  est_ba_minus_ba_diff     numeric,
  slg                      numeric,
  est_slg                  numeric,
  est_slg_minus_slg_diff   numeric,
  woba                     numeric,
  est_woba                 numeric,
  est_woba_minus_woba_diff numeric,
  era                      numeric,
  xera                     numeric,
  era_minus_xera_diff      numeric,
  created_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, snapshot_date)
);

-- Pitcher exit velocity allowed (HR + power suppression signal)
CREATE TABLE IF NOT EXISTS public.cache_statcast_pitchers_exit_velo (
  player_id               bigint NOT NULL,
  snapshot_date           date NOT NULL,
  player_name             text,
  attempts                integer,
  avg_hit_angle           numeric,
  anglesweetspotpercent   numeric,
  max_hit_speed           numeric,
  avg_hit_speed           numeric,
  ev95plus                integer,
  ev95percent             numeric,
  barrels                 integer,
  brl_percent             numeric,
  brl_pa                  numeric,
  created_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, snapshot_date)
);

-- Indexes for joins by player_id alone (most-recent snapshot lookup)
CREATE INDEX IF NOT EXISTS cache_statcast_batters_xstats_player_idx       ON public.cache_statcast_batters_xstats(player_id);
CREATE INDEX IF NOT EXISTS cache_statcast_batters_exit_velo_player_idx    ON public.cache_statcast_batters_exit_velo(player_id);
CREATE INDEX IF NOT EXISTS cache_statcast_pitchers_xstats_player_idx      ON public.cache_statcast_pitchers_xstats(player_id);
CREATE INDEX IF NOT EXISTS cache_statcast_pitchers_exit_velo_player_idx   ON public.cache_statcast_pitchers_exit_velo(player_id);

-- RLS: service_role writes; authenticated read-only (Admin UI)
ALTER TABLE public.cache_statcast_batters_xstats     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cache_statcast_batters_exit_velo  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cache_statcast_pitchers_xstats    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cache_statcast_pitchers_exit_velo ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN VALUES
    ('cache_statcast_batters_xstats'),
    ('cache_statcast_batters_exit_velo'),
    ('cache_statcast_pitchers_xstats'),
    ('cache_statcast_pitchers_exit_velo')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_authed_read ON public.%I',  t, t);
    EXECUTE format('CREATE POLICY %I_authed_read ON public.%I FOR SELECT TO authenticated USING (true)', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_service_all ON public.%I',  t, t);
    EXECUTE format('CREATE POLICY %I_service_all ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)', t, t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;

COMMENT ON TABLE public.cache_statcast_batters_xstats     IS 'D-274 Phase 0: daily Baseball Savant batter expected-stats snapshots';
COMMENT ON TABLE public.cache_statcast_batters_exit_velo  IS 'D-274 Phase 0: daily Baseball Savant batter exit-velo / barrels snapshots';
COMMENT ON TABLE public.cache_statcast_pitchers_xstats    IS 'D-274 Phase 0: daily Baseball Savant pitcher expected-stats + xERA snapshots';
COMMENT ON TABLE public.cache_statcast_pitchers_exit_velo IS 'D-274 Phase 0: daily Baseball Savant pitcher exit-velo allowed snapshots';
