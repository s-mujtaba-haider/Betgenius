-- D-729 — Cache schema completion.
-- D-718 found cache_mlb_boxscore_player_stats lacks:
--   1. runs_scored      (bat.runs)        — blocked batter_runs_scored scoring inputs
--   2. outs             (pit.outs)        — DIRECT integer; eliminates decimal-thirds
--                                           derivation (Shane Baz D-716c W/L inversion class)
--   3. batter_strikeouts (bat.strikeOuts) — distinct from existing `strikeouts` column
--                                           which is pitcher Ks; closes the K-disambiguation gap
--
-- Additive + nullable. NO existing reader breaks:
--   - historical_context_router_pitcher.ts:214 reads `strikeouts` → still pitcher Ks
--   - historical_context_router_batter.ts:471 reads `strikeouts` for OPPOSING starter → still pitcher Ks
--   - process-games-mlb doesn't query this cache by `strikeouts` field name
-- New scoring readers consult `runs_scored`, `outs`, `batter_strikeouts` explicitly.
--
-- D-726-style invariants added for the new columns: non-negative + sanity bounds.
-- Pre-flight: ZERO existing rows for new NULL columns can violate; constraints add clean.

SET statement_timeout = '120s';

ALTER TABLE public.cache_mlb_boxscore_player_stats
  ADD COLUMN IF NOT EXISTS runs_scored INT NULL;

ALTER TABLE public.cache_mlb_boxscore_player_stats
  ADD COLUMN IF NOT EXISTS outs INT NULL;

ALTER TABLE public.cache_mlb_boxscore_player_stats
  ADD COLUMN IF NOT EXISTS batter_strikeouts INT NULL;

-- D-726-style invariants on the new columns
ALTER TABLE public.cache_mlb_boxscore_player_stats
  ADD CONSTRAINT d729_runs_scored_non_negative
  CHECK (runs_scored IS NULL OR runs_scored >= 0);

ALTER TABLE public.cache_mlb_boxscore_player_stats
  ADD CONSTRAINT d729_outs_sane
  CHECK (outs IS NULL OR (outs >= 0 AND outs <= 30));

ALTER TABLE public.cache_mlb_boxscore_player_stats
  ADD CONSTRAINT d729_batter_strikeouts_non_negative
  CHECK (batter_strikeouts IS NULL OR batter_strikeouts >= 0);

ALTER TABLE public.cache_mlb_boxscore_player_stats
  ADD CONSTRAINT d729_batter_strikeouts_le_at_bats
  CHECK (batter_strikeouts IS NULL OR at_bats IS NULL OR batter_strikeouts <= at_bats);

-- Force PostgREST to learn the new columns
DO $$ BEGIN PERFORM pg_notify('pgrst', 'reload schema'); END $$;

DO $$ DECLARE n int; rec record;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
    WHERE table_schema='public' AND table_name='cache_mlb_boxscore_player_stats'
      AND column_name IN ('runs_scored','outs','batter_strikeouts');
  RAISE NOTICE '=== D-729 new columns present: % of 3 ===', n;
  FOR rec IN
    SELECT conname FROM pg_constraint WHERE conname LIKE 'd729_%'
    ORDER BY conname
  LOOP
    RAISE NOTICE '  constraint: %', rec.conname;
  END LOOP;
END $$;
