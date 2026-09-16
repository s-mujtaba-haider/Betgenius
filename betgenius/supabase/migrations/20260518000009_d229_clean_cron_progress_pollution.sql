-- D-229 Fix 1 — purge MLB pollution from cron_progress.
--
-- process-games (NBA-only) seeded cron_progress from props_cache without a
-- sport filter on 2026-05-18. fetch-odds-mlb had populated props_cache
-- with MLB events; the seed swept those in as "NBA" rows. NBA Odds API
-- call (/v4/sports/basketball_nba/events/<id>/odds) then returned 404 for
-- every MLB event_id, blocking the queue.
--
-- Code fix shipped in process-games/index.ts: seed query now includes
-- &sport=eq.nba. This migration retro-cleans the polluted rows so the
-- next cron tick picks up the legitimate NBA games (Spurs/OKC).
--
-- Strategy:
--   1. Mark known-MLB cron_progress rows for game_date=20260518 as
--      'skipped' (so reports show why they didn't get processed)
--   2. Pending NBA rows are left untouched (status='pending') so
--      next tick picks them up correctly.
--
-- Identification: any cron_progress row whose game_id corresponds to a
-- props_cache row with sport='mlb' is by definition not an NBA game and
-- should never have been seeded.

BEGIN;

WITH mlb_event_ids AS (
  SELECT DISTINCT event_id FROM public.props_cache
  WHERE sport = 'mlb' AND game_date = '20260518'
)
UPDATE public.cron_progress
SET
  status = 'skipped',
  error_message = COALESCE(error_message, 'D-229 Fix 1: MLB event seeded into NBA cron_progress queue — purged'),
  completed_at = NOW()
WHERE game_date = '20260518'
  AND status = 'pending'
  AND game_id IN (SELECT event_id FROM mlb_event_ids);

DO $$
DECLARE
  remaining_pending INT;
  skipped_count INT;
BEGIN
  SELECT COUNT(*) INTO remaining_pending FROM public.cron_progress
    WHERE game_date='20260518' AND status='pending';
  SELECT COUNT(*) INTO skipped_count FROM public.cron_progress
    WHERE game_date='20260518' AND status='skipped'
    AND error_message LIKE 'D-229 Fix 1%';
  RAISE NOTICE 'D-229 Fix 1: % MLB-polluted rows purged, % NBA rows remain pending', skipped_count, remaining_pending;
END $$;

COMMIT;
