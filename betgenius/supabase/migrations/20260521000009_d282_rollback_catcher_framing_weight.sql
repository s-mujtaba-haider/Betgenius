-- D-282 SHIP 2 ROLLBACK (2026-05-21) — catcher_framing wire deferred.
--
-- Wire path requires team-aggregate framing (entity_type='Tm') but
-- Baseball Savant returns sanitized data for Tm/Pit/Bat variants
-- (type= param triggers id/name redaction). Only Cat variant via
-- default URL returns real data (58 per-catcher rows landed today).
--
-- Per-catcher wire needs catcher→team mapping (not in CSV) or
-- game-specific starting catcher lookup (requires lineup join).
-- Both deferred to D-283. Scraper + cache stay live so D-283 can
-- consume historical Cat snapshots once mapping ships.
--
-- Forward (this migration): w_mlb_catcher_framing = 0.0
-- Rollback (restore D-282 attempt):
--   UPDATE public.algorithm_weights SET w_mlb_catcher_framing = 1.0 WHERE id = 1;

UPDATE public.algorithm_weights
SET w_mlb_catcher_framing = 0.0
WHERE id = 1;

COMMENT ON COLUMN public.algorithm_weights.w_mlb_catcher_framing IS
  'D-282 SHIP 2 DEFERRED: Cat data live in cache_statcast_framing '
  '(58 rows/snapshot, weekly Sun 4 AM ET cron). Wire requires '
  'catcher→team or game-catcher lookup — deferred to D-283. '
  'Set to 0.0 until wire ships. Bucket spec preserved in scoring_mlb.';
