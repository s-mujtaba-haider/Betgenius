-- C33 Phase 2 — pick_history.game_date TEXT → DATE migration
--
-- Background: pick_history.game_date stored as TEXT 'YYYYMMDD' format
-- (per framework C33). 25,707 rows. Bad data hygiene that explains:
--   - D-062 root cause (null game_date called .localeCompare() → black screen)
--   - BetTracker fragility — replace(/-/g, '') derivation; midnight-ET
--     timezone edge cases silently break joins
--   - Ad-hoc queries fail silently because string comparison ≠ date comparison
--
-- This migration adds a NEW column game_date_new DATE (additive, no break),
-- backfills it from the existing TEXT column. Writers will dual-write to
-- both columns during the transition window. Phase 6 (next session, after
-- ≥1 production cron tick verified clean) drops the TEXT column and
-- renames game_date_new → game_date.
--
-- This pattern keeps the system fully functional throughout the cutover —
-- old readers continue to work against the TEXT column, new readers can
-- prefer the DATE column when ready.
--
-- Pre-flight verification (CEO ran May 7):
--   pick_history.game_date data_type=text, is_nullable=YES, 25,707 rows
--   range 20260206 - 20260506, zero malformed values (all match ^[0-9]{8}$)

ALTER TABLE public.pick_history
  ADD COLUMN IF NOT EXISTS game_date_new DATE;

UPDATE public.pick_history
SET game_date_new = TO_DATE(game_date, 'YYYYMMDD')
WHERE game_date IS NOT NULL
  AND game_date ~ '^[0-9]{8}$'
  AND game_date_new IS NULL;

CREATE INDEX IF NOT EXISTS idx_pick_history_game_date_new
  ON public.pick_history (game_date_new);

COMMENT ON COLUMN public.pick_history.game_date_new IS
  'C33 transitional column. DATE-typed mirror of game_date (TEXT YYYYMMDD). '
  'Writers dual-write to both during transition window. Phase 6 drops '
  'game_date and renames game_date_new → game_date. Until Phase 6, prefer '
  'this column for any new code; legacy readers of game_date still work.';
