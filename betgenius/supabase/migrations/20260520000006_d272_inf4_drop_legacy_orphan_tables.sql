-- D-272-INF-4 (2026-05-20) — Drop 7 confirmed-orphan legacy tables.
--
-- Audit at 2026-05-20:
--   players          0 rows, 0 .from('players')         references in code
--   games            0 rows, 0 .from('games')           references in code
--   player_game_logs 0 rows, 0 .from('player_game_logs') references in code
--   props            0 rows, 0 .from('props')           references in code
--   picks            0 rows, 0 .from('picks')           references in code
--   cache            0 rows, 0 .from('cache')           references in code
--   results          0 rows, 0 .from('results')         references in code
--
-- Migration count hits in supabase/migrations/ are common-keyword
-- false positives (e.g. "games" appears in 96 migrations as substring
-- of phrases like "MLB games today"; "picks" 75× as substring of
-- "pick_history" / "picks_count").
--
-- These tables were created in the initial schema.sql when the
-- project was scaffolded but were superseded by the
-- recommendations_cache / props_cache / pick_history / bets writers.
--
-- Pre-drop archive: zero rows to archive (already empty).
--
-- Rollback (within Supabase backup retention window): restore from
-- daily backup. Outside that window: re-create by running
-- supabase/schema.sql to recreate the original empty structure.

-- Use IF EXISTS so re-running this migration is a no-op.
-- CASCADE drops any orphan dependent objects (constraints, triggers,
-- policies). All 7 have zero application references so CASCADE is
-- safe.

DROP TABLE IF EXISTS public.players          CASCADE;
DROP TABLE IF EXISTS public.games            CASCADE;
DROP TABLE IF EXISTS public.player_game_logs CASCADE;
DROP TABLE IF EXISTS public.props            CASCADE;
DROP TABLE IF EXISTS public.picks            CASCADE;
DROP TABLE IF EXISTS public.cache            CASCADE;
DROP TABLE IF EXISTS public.results          CASCADE;

-- Sentinel comment row so we know this migration ran (no separate
-- audit table needed; pg_migrations records execution).
DO $$
BEGIN
  RAISE NOTICE '[D-272-INF-4] dropped 7 legacy orphan tables: players, games, player_game_logs, props, picks, cache, results';
END $$;
