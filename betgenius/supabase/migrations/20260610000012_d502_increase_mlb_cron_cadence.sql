-- D-502 (2026-06-10) — increase process-games-mlb cron cadence to clear the
-- full slate within ~45 min instead of trickling 2/tick across ~3 hours.
-- §2 CEO-APPROVED.
--
-- ROOT NUMBERS (from D-472 measurement + D-473 sharding design):
--   - D-472 measured per-tick runtime at 134-142s for 4-5 active-game ticks
--     (peak 142.7s = only 7.3s margin from the 150s edge-function ceiling).
--   - D-473 introduced sharding at N=2 games/tick to keep runtime safely
--     under the ceiling while adding the D-474/D-475/D-476 markets (which
--     would have pushed runtime to 174-192s on full-slate ticks).
--
-- D-501 (the diagnostic this batch follows) confirmed:
--   - Schedule (MLB Stats API) had 15 games today
--   - props_cache had 15,902 prop rows covering them
--   - Only 4 of 15 had been scored — the 4 earliest by gameTime,
--     scored at the last 2 ticks (04:05 + 04:35 UTC) before the cron window
--     closed for ~12.5 hours
--   - Once cron resumes at 17:05 UTC, current schedule (`5,35 17-23,0-4 * * *`,
--     = 30-min interval) needs ~6 more ticks (3 hours) to clear the remaining 11
--
-- CHOSEN APPROACH: Option 1 (increase tick frequency) ONLY.
--   - Cadence: `5,35 17-23,0-4 * * *` (every 30 min) → `*/5 17-23,0-4 * * *`
--     (every 5 min during the same UTC 17-23,0-4 window).
--   - N games/tick: UNCHANGED at 2 (D-473's `D473_N_GAMES_PER_TICK = 2`).
--   - Result: 15-game slate clears in ceil(15/2) = 8 ticks × 5 min = 40 min
--     (under the 45-min target).
--
-- WHY NOT increase N to 3 as Option 3 suggests?
--   - D-472's 4-5 games at 134-142s already shows runtime variance per game.
--     Some games have ~150 picks each (D-501 showed 134-200+ picks/game) and
--     others ~10. A tick that happens to pick 3 worst-case games could hit
--     180-200s and silently die mid-tick (D-446 class).
--   - Keeping N=2 preserves the proven-safe per-tick runtime envelope.
--     Increasing frequency alone meets the 45-min target without runtime risk.
--
-- INVOCATION COST: 5-min cadence × 12-hr window = 144 ticks/day (was 24).
--   - 139 of 144 will be empty (no unscored games remaining; fn returns
--     `{"success":true,"skipped":true,"reason":"no scheduled MLB games"}`
--     or an analogous skip after the load + schedule + progress check).
--   - Empty ticks measured at ~1.7s in D-499-APPLY (HTTP 200 ad-hoc invoke).
--   - 139 empty ticks × 1.7s = ~240s of compute/day on empty work. Cheap.
--   - Anthropic Sonnet calls: SAME total (15 games × ~150 picks each = ~2250
--     calls/day, just compressed from ~3 hours into ~40 min). No rate-limit
--     concern (Anthropic allows much higher than 60 req/min).
--   - Odds API: process-games-mlb reads props_cache, doesn't refetch odds.
--     No Odds API cost increase. (fetch-odds-mlb has its own cron, unchanged.)
--   - MLB Stats API schedule call: free public endpoint, 1/tick. Negligible.
--
-- DEDUP / CONCURRENCY:
--   - At 5-min cadence with ~134-142s per-tick peak runtime, concurrent
--     overlap is unlikely (300s interval vs 142s peak = 2.1x margin).
--   - Even if two ticks DO overlap: the mlb_scoring_progress unique index
--     (game_date, game_pk) + ON CONFLICT DO NOTHING + idempotent rec_cache
--     and pick_history upserts (D-446) make double-scoring safe. Worst case
--     = wasted Sonnet credits on a re-scored game, not data corruption.
--
-- ROLLBACK (if anything breaks):
--   SELECT cron.alter_job(
--     (SELECT jobid FROM cron.job WHERE jobname = 'process-games-mlb-30min'),
--     schedule := '5,35 17-23,0-4 * * *'
--   );

DO $$
DECLARE
  v_jobid    BIGINT;
  v_old_sch  TEXT;
  v_new_sch  TEXT := '*/5 17-23,0-4 * * *';
BEGIN
  SELECT jobid, schedule INTO v_jobid, v_old_sch
  FROM cron.job WHERE jobname = 'process-games-mlb-30min';

  IF v_jobid IS NULL THEN
    RAISE EXCEPTION '[D-502] cron jobname process-games-mlb-30min not found';
  END IF;

  RAISE NOTICE '[D-502] found jobid=% current schedule=%', v_jobid, v_old_sch;

  PERFORM cron.alter_job(v_jobid, schedule := v_new_sch);

  -- Sanity check the change actually landed
  SELECT schedule INTO v_old_sch FROM cron.job WHERE jobid = v_jobid;
  IF v_old_sch <> v_new_sch THEN
    RAISE EXCEPTION '[D-502] alter_job did not take — expected % got %', v_new_sch, v_old_sch;
  END IF;

  RAISE NOTICE '[D-502] jobid=% schedule changed: % → %', v_jobid, '5,35 17-23,0-4 * * *', v_new_sch;
  RAISE NOTICE '[D-502] expected outcome: 15-game slate clears in ceil(15/2)=8 ticks × 5min = 40min after the next 17:05 UTC cron resume';
END $$;
