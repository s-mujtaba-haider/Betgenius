-- D-197 — rescore-backfill-picks performance indexes.
--
-- Source: D-194 escalation #2 documented at /docs/loop/escalations.md
-- 2026-05-17. Empirical measurement: single-date rescore call against
-- 2024-12-15 (~20 picks) hit Supabase 150s IDLE_TIMEOUT. Per-pick latency
-- ~5s vs expected ~500ms = 10× gap explained by sequential scans on the
-- two read paths inside the per-pick loop.
--
-- TWO INDEXES:
--
-- 1) idx_cgs_lookup_by_team
--    Supports `rescore-backfill-picks` scoreboard lookup at index.ts:221:
--      cache_game_scoreboard
--        ?game_date=eq.X&sport=eq.nba
--        &or=(home_team.eq.TEAM,away_team.eq.TEAM)
--    The existing idx_cgs_date covers (game_date, sport) but the home/away
--    team OR-filter falls back to a row scan over each date's matches.
--    With ~12 rows per game_date this is fine on small queries but is
--    multiplied by N picks-per-date inside the per-pick loop.
--
-- 2) idx_cods_team_date_desc
--    Supports the nearest-prior fallback at
--    rescore-backfill-picks/index.ts:68:
--      cache_opponent_defensive_stats
--        ?team_name=eq.X&sport=eq.nba
--        &snapshot_date=lte.D&order=snapshot_date.desc&limit=1
--    The existing schema has PK (team_name, snapshot_date, sport) which
--    helps the equality+range query but the explicit DESC index makes the
--    nearest-prior fallback a B-tree lookup instead of an index scan.
--    Marginal gain on its own; load-bearing when called per-pick.
--
-- §1.17 SCHEMA AUDIT — INDEXES ONLY, NO COLUMN CHANGES:
-- This migration adds two indexes via `CREATE INDEX IF NOT EXISTS`. There
-- are NO column additions, NO type changes, NO writer-path implications.
-- §1.17 audit is N/A in its full form. Idempotent — re-applying is a no-op.
--
-- §1.14 N/A — no views touched.
--
-- §1.12 VERIFICATION — paired migration `20260517000002_d197_verification.sql`
-- documents the post-deploy single-date rescore latency check + the smoke
-- test result.
--
-- ROLLBACK: `DROP INDEX IF EXISTS public.idx_cgs_lookup_by_team;
--           DROP INDEX IF EXISTS public.idx_cods_team_date_desc;`
-- Indexes are zero-cost to drop and zero-risk to recreate. No data movement.

CREATE INDEX IF NOT EXISTS idx_cgs_lookup_by_team
  ON public.cache_game_scoreboard (game_date, sport, home_team, away_team);

CREATE INDEX IF NOT EXISTS idx_cods_team_date_desc
  ON public.cache_opponent_defensive_stats (team_name, sport, snapshot_date DESC);

COMMENT ON INDEX public.idx_cgs_lookup_by_team IS
  'D-197 — supports rescore-backfill-picks scoreboard lookup with OR-filter on home_team/away_team. See migration 20260517000001.';

COMMENT ON INDEX public.idx_cods_team_date_desc IS
  'D-197 — supports rescore-backfill-picks nearest-prior fallback on opp defensive stats. See migration 20260517000001.';
