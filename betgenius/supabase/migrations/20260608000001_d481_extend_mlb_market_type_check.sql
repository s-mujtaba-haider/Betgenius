-- D-481 SHIP 1 (2026-06-08) — Fix the rpc_failed 23514 data-loss bug.
--
-- ROOT CAUSE (per D-480 diagnosis): the existing CHECK constraint
-- `pick_history_mlb_market_type_check` from D-204
-- (migration 20260517000014_d204_mlb_factor_columns.sql) restricts
-- mlb_market_type to 7 values + NULL:
--   ('pitcher_k', 'batter_hits', 'batter_hr', 'batter_total_bases',
--    'batter_rbis', 'game_side', 'game_total')
--
-- D-474, D-475, D-476 (deployed 2026-06-07) added 3 NEW market types
-- that are NOT in the allowed list:
--   - batter_strikeouts (D-474)
--   - batter_runs_scored (D-475)
--   - pitcher_outs (D-476)
-- Every pick_history write for these markets has been failing with
-- Postgres code 23514 since 2026-06-07. ~560 real production picks
-- LOST from pick_history (they live in rec_cache but never landed
-- in the documented-WR table).
--
-- THIS MIGRATION:
--   1. DROPs the existing CHECK constraint.
--   2. ADDs the same constraint extended with the 3 missing values.
-- Non-destructive: no rows deleted, no rows fail the new constraint
-- (the 3 new values currently have 0 rows in pick_history — all were
-- rejected, so the new constraint is satisfied by all existing data).
-- Expected re-apply time: ~50ms (one ALTER scan).
--
-- The 3 new market-type strings were confirmed by reading the
-- exact values the scorers write at:
--   process-games-mlb/index.ts:3169 → "batter_strikeouts" (D-474)
--   process-games-mlb/index.ts:3178 → "batter_runs_scored" (D-475)
--   process-games-mlb/index.ts:3190 → "pitcher_outs" (D-476)
-- These map 1:1 to the prop_type → market route in classifyMarket()
-- and the scorer dispatch tables.

ALTER TABLE public.pick_history
  DROP CONSTRAINT IF EXISTS pick_history_mlb_market_type_check;

ALTER TABLE public.pick_history
  ADD CONSTRAINT pick_history_mlb_market_type_check CHECK (
    mlb_market_type IS NULL OR mlb_market_type IN (
      -- D-204 originals (2026-05-17 migration 20260517000014):
      'pitcher_k',
      'batter_hits',
      'batter_hr',
      'batter_total_bases',
      'batter_rbis',
      'game_side',
      'game_total',
      -- D-474 / D-475 / D-476 additions (2026-06-07, value confirmed
      -- against process-games-mlb/index.ts:3169 / 3178 / 3190):
      'batter_strikeouts',
      'batter_runs_scored',
      'pitcher_outs'
    )
  );

COMMENT ON COLUMN public.pick_history.mlb_market_type IS
  'D-204 (2026-05-17) + D-481 (2026-06-08): MLB market enum. '
  'Allowed: pitcher_k | batter_hits | batter_hr | batter_total_bases | '
  'batter_rbis | game_side | game_total | batter_strikeouts | '
  'batter_runs_scored | pitcher_outs. NULL for non-MLB picks. '
  'Lesson (D-481): new MLB market types MUST also be added here at deploy '
  'time, or pick_history writes silently fail with Postgres 23514 and the '
  'picks are lost from the documented-WR table while staying visible in '
  'rec_cache. D-480 quantified ~560 picks lost across D-474/D-475/D-476 '
  'before this migration. Add the value here whenever a new market enters '
  'the queue; verify writes succeed before declaring the market LIVE.';
