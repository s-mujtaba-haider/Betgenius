-- D-653 SHIP 1 VERIFY — force re-score of ONE game so we can observe v3 live.
-- Delete the mlb_scoring_progress row for pk=824180 (CLE @ HOU, 2026-06-20 23:15Z).
-- D-617 ring (a) "never scored" fires on next cron tick → game gets scored under
-- v3-promoted path → pick_history rows land with v3 confidence + factors → we observe.
-- ROLLBACK: not needed — the cron auto-INSERTs the row on the next score.
DO $$
DECLARE
  v_count INTEGER;
  v_prior_scored_at TIMESTAMPTZ;
BEGIN
  SELECT scored_at INTO v_prior_scored_at FROM mlb_scoring_progress
    WHERE game_pk = 824180 AND game_date = '20260620';
  RAISE NOTICE 'Prior scored_at for pk=824180: %', v_prior_scored_at;

  DELETE FROM mlb_scoring_progress
    WHERE game_pk = 824180 AND game_date = '20260620';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'D-653 SHIP 1 verify: deleted % row(s) for pk=824180 game_date=20260620', v_count;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'expected to delete exactly 1 row, deleted %', v_count;
  END IF;
END $$;
