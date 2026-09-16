-- D-511 SHIP 1 — schema additions for CLV capture.
--
-- 5 columns on pick_history:
--   closing_odds              integer    — odds at close for same line+side
--   closing_line              numeric    — line at close (may differ from pick line)
--   clv_pct                   numeric    — implied(close) - implied(pick), positive = beat close
--   closing_captured_at       timestamptz — when capture cron stamped this row
--   closing_capture_reason    text       — 'success' / 'line_moved' / 'market_absent' / 'book_absent_hr'
--
-- Index supports the capture function's "pending captures" hot-path query.
--
-- Rollback:
--   DROP INDEX IF EXISTS public.idx_ph_closing_pending;
--   ALTER TABLE public.pick_history
--     DROP COLUMN IF EXISTS closing_odds,
--     DROP COLUMN IF EXISTS closing_line,
--     DROP COLUMN IF EXISTS clv_pct,
--     DROP COLUMN IF EXISTS closing_captured_at,
--     DROP COLUMN IF EXISTS closing_capture_reason;

ALTER TABLE public.pick_history
  ADD COLUMN IF NOT EXISTS closing_odds            integer,
  ADD COLUMN IF NOT EXISTS closing_line            numeric,
  ADD COLUMN IF NOT EXISTS clv_pct                 numeric,
  ADD COLUMN IF NOT EXISTS closing_captured_at     timestamptz,
  ADD COLUMN IF NOT EXISTS closing_capture_reason  text;

CREATE INDEX IF NOT EXISTS idx_ph_closing_pending
  ON public.pick_history (game_time, id)
  WHERE closing_captured_at IS NULL AND sport='mlb' AND is_synthetic=false;

DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-511 schema] new pick_history CLV columns:';
  FOR r IN
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name='pick_history'
      AND column_name IN ('closing_odds','closing_line','clv_pct',
                          'closing_captured_at','closing_capture_reason')
    ORDER BY column_name
  LOOP RAISE NOTICE '  %  %', r.column_name, r.data_type; END LOOP;

  RAISE NOTICE '[D-511 schema] partial index created:';
  FOR r IN
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname='public' AND tablename='pick_history'
      AND indexname='idx_ph_closing_pending'
  LOOP RAISE NOTICE '  %', r.indexdef; END LOOP;
END $$;
