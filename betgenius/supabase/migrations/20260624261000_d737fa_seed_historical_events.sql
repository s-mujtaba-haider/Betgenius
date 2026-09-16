-- D-737f-A SHIP 1 — Seed cache_mlb_historical_events from cache_mlb_historical_outcomes
-- for the full window (opening day → today). The outcomes table has all the columns
-- the events table needs (event_id, commence_time, home_team, away_team, game_pk).
--
-- Why this works: cache_mlb_historical_events is the schedule/event_id mapping; it
-- was last populated by the D-298 historical-replay pipeline (capped at May 24).
-- cache_mlb_historical_outcomes has been populated by a DIFFERENT pipeline that
-- covers a longer window (316 rows for Jun 1-24 alone). Sourcing events from outcomes
-- gives us the missing piece WITHOUT new API calls.
--
-- Idempotent: ON CONFLICT DO NOTHING.
-- D-726-style invariants: NOT NULL event_id, commence_time, home_team, away_team.

INSERT INTO cache_mlb_historical_events (event_id, commence_time, home_team, away_team, game_pk)
SELECT DISTINCT ON (event_id)
  event_id,
  commence_time,
  home_team,
  away_team,
  game_pk
FROM cache_mlb_historical_outcomes
WHERE event_id IS NOT NULL
  AND commence_time IS NOT NULL
  AND home_team IS NOT NULL
  AND away_team IS NOT NULL
  AND commence_time >= '2026-03-26'
ON CONFLICT (event_id) DO NOTHING;

-- Verify backfill (logged via raise notice — Supabase will show in db push output)
DO $$
DECLARE
  events_total INTEGER;
  events_jun INTEGER;
  outcomes_jun INTEGER;
BEGIN
  SELECT COUNT(*) INTO events_total FROM cache_mlb_historical_events;
  SELECT COUNT(*) INTO events_jun FROM cache_mlb_historical_events
    WHERE commence_time >= '2026-06-01' AND commence_time < '2026-06-25';
  SELECT COUNT(*) INTO outcomes_jun FROM cache_mlb_historical_outcomes
    WHERE commence_time >= '2026-06-01' AND commence_time < '2026-06-25';
  RAISE NOTICE 'D-737f-A: cache_mlb_historical_events total=% (Jun 1-24=%); outcomes Jun=%',
    events_total, events_jun, outcomes_jun;
END $$;
