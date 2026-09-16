-- ============================================================================
-- Migration: cache_foundation_phase1
-- Created : 2026-05-01
-- Phase   : 1 of 10 (caching architecture per framework §20)
--
-- Purpose : Foundation tables for the caching architecture. SIX cache tables
--           (cache_* prefix per CEO decision #7 — also avoids collision with
--           the legacy `player_game_logs` table from the Jan 2026 schema)
--           with their indexes + RLS policies + a storage-monitoring view.
--           **Empty post-deploy** — no rows are inserted; no readers or
--           writers are wired yet. Phase 2 (writers in process-games) ships
--           in a separate session.
--
-- Naming   : All Phase 1 tables use the `cache_` prefix:
--              cache_player_game_logs
--              cache_player_metadata
--              cache_team_metadata
--              cache_opponent_defensive_stats
--              cache_team_injuries
--              cache_game_scoreboard
--            Honors the "public schema with cache_* discipline" decision
--            and prevents collision with `player_game_logs` from
--            `supabase/schema.sql` (legacy, empty, structurally different
--            — has `stats JSONB` blob instead of normalized stat columns).
--
-- Idempotent: every CREATE uses IF NOT EXISTS; every ENABLE RLS is a no-op
--             when already enabled; every CREATE POLICY is preceded by
--             DROP POLICY IF EXISTS so the migration can be re-run safely.
--             The view uses CREATE OR REPLACE.
--
-- Cardinal Rule #1.4 documentation:
--   What     : 1) CREATE TABLE for 6 cache tables (cache_* prefix).
--              2) Eight CREATE INDEX statements (1-2 per table) for the
--                 dominant query patterns.
--              3) ALTER TABLE ENABLE ROW LEVEL SECURITY on all 6 tables.
--              4) Six SELECT policies, all `TO authenticated USING (true)`.
--                 Service role bypasses RLS automatically — no INSERT /
--                 UPDATE / DELETE policies needed; cron writes via
--                 service_role.
--              5) CREATE OR REPLACE VIEW public.cache_storage_summary that
--                 surfaces row count + storage MB per cache-relevant table.
--                 Gated by `public.is_admin()` (added in 20260429000003).
--
--   Why      : Tonight ships the foundation only — the structural skeleton
--              that subsequent phases populate, read from, and monitor.
--              Per CEO direction (May 1) after v2 design review:
--              read-through Option B (cron-only writes), snapshot pattern
--              for cache_opponent_defensive_stats + cache_team_injuries
--              (so backtest_weights_v2 can replay state-at-pick-time),
--              authenticated SELECT, public schema with cache_*
--              discipline, NBA-only for now (sport column on every table
--              keeps MLB door open).
--
--              Eight CEO decisions approved before this migration:
--              (1) 6-table scope, (2) RLS authenticated read service-role
--              write, (3) snapshot pattern on the two time-sensitive tables,
--              (4) Option B read-through, (5) Phase 4 backfill gated behind
--              CEO manual confirm, (6) cache_storage_summary view, (7)
--              public schema cache_* prefix, (8) tables empty post-Phase-1.
--
--   When     : 2026-05-01, applied via supabase db push immediately after
--              CEO review of the migration content.
--
--   Impact   : ZERO behavior change at deploy time. Tables are empty; no
--              edge function reads from them; no cron writes to them. The
--              ONLY observable change is `\d+ cache_player_game_logs` (and
--              the other 5) shows the new schema, and SELECT * returns []
--              under any role. Anon role reads return [] (RLS authenticated
--              policy excludes anon — same shape as the Apr 30 RLS pass).
--              Existing app surfaces (Dashboard, Performance, Games,
--              Admin, Evaluator, Tracker, Settings, AuthGate) are
--              completely untouched. No edge function deploys required.
--              Storage footprint at apply time = empty tables + view
--              definition + indexes < 10 KB total.
--
--   Rollback : -- Drop view first (depends on tables):
--              DROP VIEW IF EXISTS public.cache_storage_summary;
--              -- Drop tables (CASCADE cleans up policies + indexes):
--              DROP TABLE IF EXISTS public.cache_game_scoreboard CASCADE;
--              DROP TABLE IF EXISTS public.cache_team_injuries CASCADE;
--              DROP TABLE IF EXISTS public.cache_opponent_defensive_stats CASCADE;
--              DROP TABLE IF EXISTS public.cache_team_metadata CASCADE;
--              DROP TABLE IF EXISTS public.cache_player_metadata CASCADE;
--              DROP TABLE IF EXISTS public.cache_player_game_logs CASCADE;
--              -- No data was written; nothing to restore.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) cache_player_game_logs — per-player per-game stat row.
--    Native snapshot via game_date dimension in PK. Refresh: cron writes
--    after a player's game settles. Retention: 365 days (Phase 10 TTL cron).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cache_player_game_logs (
  player_id    TEXT          NOT NULL,
  player_name  TEXT          NOT NULL,
  game_date    DATE          NOT NULL,
  opponent     TEXT,
  is_home      BOOLEAN,
  minutes      NUMERIC(4,1),
  points       INTEGER,
  rebounds     INTEGER,
  assists      INTEGER,
  threes       INTEGER,
  steals       INTEGER,
  blocks       INTEGER,
  turnovers    INTEGER,
  result       TEXT,
  fetched_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  source       TEXT          NOT NULL DEFAULT 'espn',
  sport        TEXT          NOT NULL DEFAULT 'nba',
  PRIMARY KEY (player_id, game_date, sport)
);
CREATE INDEX IF NOT EXISTS idx_cpgl_name    ON public.cache_player_game_logs (lower(player_name));
CREATE INDEX IF NOT EXISTS idx_cpgl_fetched ON public.cache_player_game_logs (fetched_at);

COMMENT ON TABLE public.cache_player_game_logs IS
  'Per-player per-game stat snapshot, written by process-games cron after '
  'each game settles. Retention 365 days. Single writer (cron service_role); '
  'authenticated reads. PK includes sport for MLB extension.';

-- ----------------------------------------------------------------------------
-- 2) cache_player_metadata — current attributes per player. Overwrite-with-
--    last_updated. is_active soft-delete flag for retired/cut players.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cache_player_metadata (
  player_id      TEXT        PRIMARY KEY,
  player_name    TEXT        NOT NULL,
  team_name      TEXT,
  position       TEXT,
  height_inches  INTEGER,
  weight_lbs     INTEGER,
  bdl_id         INTEGER,
  age            INTEGER,
  experience     INTEGER,
  is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
  last_updated   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sport          TEXT        NOT NULL DEFAULT 'nba'
);
CREATE INDEX IF NOT EXISTS idx_cpm_name ON public.cache_player_metadata (lower(player_name));
CREATE INDEX IF NOT EXISTS idx_cpm_bdl  ON public.cache_player_metadata (bdl_id);

COMMENT ON TABLE public.cache_player_metadata IS
  'Player roster metadata (ESPN ID, BDL ID, team, position, etc.). Single '
  'row per player; overwrite on update. is_active=false soft-deletes retired '
  'players without losing historical references.';

-- ----------------------------------------------------------------------------
-- 3) cache_team_metadata — slow-changing team attributes. Overwrite.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cache_team_metadata (
  team_name         TEXT          NOT NULL,
  abbreviation      TEXT          NOT NULL,
  bdl_id            INTEGER,
  espn_id           TEXT,
  conference        TEXT,
  division          TEXT,
  current_pace      NUMERIC(5,2),
  schedule_density  NUMERIC(3,2),
  last_updated      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  sport             TEXT          NOT NULL DEFAULT 'nba',
  PRIMARY KEY (team_name, sport)
);

COMMENT ON TABLE public.cache_team_metadata IS
  'Team roster + schedule attributes. 30 NBA rows. Refreshed weekly. '
  'current_pace + schedule_density are NBA-shaped; MLB rows leave them NULL '
  'and add MLB-specific columns in a later additive migration.';

-- ----------------------------------------------------------------------------
-- 4) cache_opponent_defensive_stats — REVISED snapshot pattern.
--    PK includes snapshot_date so backtest_weights_v2 can replay
--    state-at-pick-time. Daily snapshot via cron at 4 AM ET.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cache_opponent_defensive_stats (
  team_name           TEXT          NOT NULL,
  snapshot_date       DATE          NOT NULL,
  fetched_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  bdl_team_id         INTEGER,
  ppg_allowed         NUMERIC(5,2),
  rpg_allowed         NUMERIC(5,2),
  apg_allowed         NUMERIC(5,2),
  spg_allowed         NUMERIC(4,2),
  bpg_allowed         NUMERIC(4,2),
  threes_allowed      NUMERIC(4,2),
  fg_pct_allowed      NUMERIC(4,3),
  three_pct_allowed   NUMERIC(4,3),
  pace                NUMERIC(5,2),
  net_rating          NUMERIC(5,2),
  sos                 NUMERIC(5,2),
  sport               TEXT          NOT NULL DEFAULT 'nba',
  PRIMARY KEY (team_name, snapshot_date, sport)
);
CREATE INDEX IF NOT EXISTS idx_cods_team ON public.cache_opponent_defensive_stats (team_name, sport);

COMMENT ON TABLE public.cache_opponent_defensive_stats IS
  'Daily snapshot of team-level defensive numbers. PK includes snapshot_date '
  'so historical state is preserved (backtest replay, retroactive analysis). '
  'Retention 365 days via TTL cron (Phase 10).';

-- ----------------------------------------------------------------------------
-- 5) cache_team_injuries — REVISED snapshot pattern.
--    Daily snapshot of who is injured per team. PK includes snapshot_date so
--    "who was out on date X" queries work. Retention 30 days.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cache_team_injuries (
  player_name    TEXT          NOT NULL,
  team_name      TEXT          NOT NULL,
  snapshot_date  DATE          NOT NULL,
  status         TEXT          NOT NULL,
  description    TEXT,
  fetched_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  bdl_id         INTEGER,
  sport          TEXT          NOT NULL DEFAULT 'nba',
  PRIMARY KEY (player_name, team_name, snapshot_date, sport)
);
CREATE INDEX IF NOT EXISTS idx_cti_team ON public.cache_team_injuries (team_name, snapshot_date, sport);

COMMENT ON TABLE public.cache_team_injuries IS
  'Daily snapshot of BDL injury feed. PK includes snapshot_date so '
  'scoring at pick-time can replay the injury state visible at that moment. '
  'Retention 30 days via TTL cron (Phase 10).';

-- ----------------------------------------------------------------------------
-- 6) cache_game_scoreboard — ESPN scoreboard for the slate. Cross-cutting
--    (used by both process-games and resolve-picks). Refresh: piggybacks
--    on those crons. Retention 365 days.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cache_game_scoreboard (
  game_id      TEXT          NOT NULL,
  game_date    DATE          NOT NULL,
  home_team    TEXT          NOT NULL,
  away_team    TEXT          NOT NULL,
  start_time   TIMESTAMPTZ,
  status       TEXT          NOT NULL,
  home_score   INTEGER,
  away_score   INTEGER,
  fetched_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  sport        TEXT          NOT NULL DEFAULT 'nba',
  PRIMARY KEY (game_id, sport)
);
CREATE INDEX IF NOT EXISTS idx_cgs_date ON public.cache_game_scoreboard (game_date, sport);

COMMENT ON TABLE public.cache_game_scoreboard IS
  'Cached ESPN scoreboard rows. status: scheduled | in_progress | final. '
  'Cross-cutting: process-games uses for opponent team-id lookup + B2B '
  'detection; resolve-picks uses for final scores. Single writer (cron).';

-- ============================================================================
-- RLS — enable on all 6 tables. SELECT for authenticated; service-role
-- bypasses RLS automatically for writes (Supabase default).
-- ============================================================================

ALTER TABLE public.cache_player_game_logs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cache_player_metadata            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cache_team_metadata              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cache_opponent_defensive_stats   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cache_team_injuries              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cache_game_scoreboard            ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cache_player_game_logs_select_authed         ON public.cache_player_game_logs;
CREATE POLICY cache_player_game_logs_select_authed ON public.cache_player_game_logs
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS cache_player_metadata_select_authed          ON public.cache_player_metadata;
CREATE POLICY cache_player_metadata_select_authed ON public.cache_player_metadata
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS cache_team_metadata_select_authed            ON public.cache_team_metadata;
CREATE POLICY cache_team_metadata_select_authed ON public.cache_team_metadata
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS cache_opponent_defensive_stats_select_authed ON public.cache_opponent_defensive_stats;
CREATE POLICY cache_opponent_defensive_stats_select_authed ON public.cache_opponent_defensive_stats
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS cache_team_injuries_select_authed            ON public.cache_team_injuries;
CREATE POLICY cache_team_injuries_select_authed ON public.cache_team_injuries
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS cache_game_scoreboard_select_authed          ON public.cache_game_scoreboard;
CREATE POLICY cache_game_scoreboard_select_authed ON public.cache_game_scoreboard
  FOR SELECT TO authenticated USING (true);

-- ============================================================================
-- View — cache_storage_summary
--
-- Surfaces row count + storage MB per cache-relevant table. Gated by
-- public.is_admin() (defined in 20260429000003) so non-admin authed users
-- get [] when they query it. pg_total_relation_size + pg_stat_user_tables
-- read system catalogs, not user tables, so RLS doesn't naturally apply —
-- the WHERE-is_admin() is the gate.
--
-- Includes the 6 new cache tables + existing cache surfaces (props_cache,
-- recommendations_cache, pick_history, bets, etc.) so Admin can see total
-- footprint at a glance.
-- ============================================================================

CREATE OR REPLACE VIEW public.cache_storage_summary AS
SELECT
  c.relname                                  AS table_name,
  s.n_live_tup                               AS row_count,
  pg_total_relation_size(c.oid)              AS bytes,
  ROUND(pg_total_relation_size(c.oid) / 1024.0 / 1024.0, 2)            AS mb,
  ROUND(pg_total_relation_size(c.oid) / 1024.0 / 1024.0 / 8192.0 * 100, 4) AS pct_of_8gb_limit
FROM pg_class c
JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE c.relname IN (
  -- New Phase 1 cache tables:
  'cache_player_game_logs',
  'cache_player_metadata',
  'cache_team_metadata',
  'cache_opponent_defensive_stats',
  'cache_team_injuries',
  'cache_game_scoreboard',
  -- Existing cache + data tables (so Admin sees total cache footprint):
  'props_cache',
  'recommendations_cache',
  'pick_history',
  'bets',
  'allowed_emails',
  'algorithm_weights',
  'cron_progress',
  'api_usage',
  'error_log',
  'run_log',
  'player_data_cache'
)
AND public.is_admin()
ORDER BY pg_total_relation_size(c.oid) DESC;

COMMENT ON VIEW public.cache_storage_summary IS
  'Per-table row count + storage MB across cache + data tables. Admin-only '
  'via is_admin() predicate in WHERE. Powers the Admin Cache Storage card '
  '(shipping in a later phase). Non-admin authed users see [].';
