-- D-165 same-player multi-market dedup (May 14, 2026)
--
-- When the same player has multiple props recommended on the same game_date
-- (e.g., points OVER + rebounds OVER + assists UNDER for player X today),
-- this creates correlated risk and inflates apparent pick volume.
--
-- Strategy: keep ALL picks in the DB (no data loss) but mark all-but-the-
-- highest-confidence as `is_secondary_market = TRUE`. Dashboard defaults to
-- primary-market view with a toggle to show all.
--
-- Computation is via AFTER INSERT/UPDATE trigger on pick_history (and the
-- same on recommendations_cache). The trigger recomputes the secondary flag
-- for the entire (player_name, game_date) group — so when a higher-confidence
-- pick lands AFTER a lower one was written, the earlier row flips to TRUE.
--
-- Scope: applies only to non-synthetic, non-voided, source='process-games'
-- rows. Backfill rows and evaluator/analyze-pick rows are ignored.
--
-- Closes D-148 §15.10 #6.

BEGIN;

-- ============================================================================
-- pick_history
-- ============================================================================

ALTER TABLE public.pick_history
  ADD COLUMN IF NOT EXISTS is_secondary_market BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.pick_history.is_secondary_market IS
  'D-165: TRUE for all picks of (player_name, game_date) except the highest-confidence row. Maintained by trigger.';

CREATE INDEX IF NOT EXISTS pick_history_player_gdate_idx
  ON public.pick_history (player_name, game_date)
  WHERE is_synthetic = FALSE AND voided = FALSE AND source = 'process-games';

-- ============================================================================
-- Trigger function — recomputes is_secondary_market for one (player, game_date)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.d165_recompute_secondary_market(
  p_player TEXT, p_game_date DATE
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_max_conf INT;
BEGIN
  -- Find the max confidence in the (player, game_date) group.
  SELECT MAX(confidence) INTO v_max_conf
  FROM public.pick_history
  WHERE player_name = p_player
    AND game_date = p_game_date
    AND is_synthetic = FALSE
    AND COALESCE(voided, FALSE) = FALSE
    AND source = 'process-games';

  -- If group has 0 or 1 picks, max_conf is the row itself (or null) —
  -- nothing to flip. Still run the UPDATE so deletes that leave 1 row
  -- correctly reset the flag.
  IF v_max_conf IS NULL THEN
    RETURN;
  END IF;

  -- Mark anything below the max as secondary, the rest as primary.
  UPDATE public.pick_history
  SET is_secondary_market = (confidence < v_max_conf)
  WHERE player_name = p_player
    AND game_date = p_game_date
    AND is_synthetic = FALSE
    AND COALESCE(voided, FALSE) = FALSE
    AND source = 'process-games'
    AND is_secondary_market <> (confidence < v_max_conf);
END;
$$;

COMMENT ON FUNCTION public.d165_recompute_secondary_market(TEXT, DATE) IS
  'D-165: recompute is_secondary_market for one (player, game_date). Only flips rows whose flag needs to change — avoids trigger-recursion noise.';

-- ============================================================================
-- AFTER-row trigger on pick_history
-- ============================================================================

CREATE OR REPLACE FUNCTION public.d165_pick_history_secondary_trg()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Avoid recursion: only fire when we're at trigger depth 1 (i.e., the
  -- outer write that triggered us). Our recomputation UPDATE will fire
  -- this trigger again at depth 2 — skip those.
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  -- Only act on the rows that participate in dedup.
  IF NEW.is_synthetic = TRUE THEN RETURN NEW; END IF;
  IF COALESCE(NEW.voided, FALSE) = TRUE THEN RETURN NEW; END IF;
  IF NEW.source IS DISTINCT FROM 'process-games' THEN RETURN NEW; END IF;

  PERFORM public.d165_recompute_secondary_market(NEW.player_name, NEW.game_date);

  -- If this UPDATE moved the row across player_name OR game_date (rare —
  -- mostly hypothetical), also recompute the OLD group.
  IF TG_OP = 'UPDATE' THEN
    IF NEW.player_name IS DISTINCT FROM OLD.player_name
       OR NEW.game_date IS DISTINCT FROM OLD.game_date THEN
      PERFORM public.d165_recompute_secondary_market(OLD.player_name, OLD.game_date);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pick_history_d165_secondary_market_trg ON public.pick_history;
CREATE TRIGGER pick_history_d165_secondary_market_trg
  AFTER INSERT OR UPDATE OF confidence, voided, source, is_synthetic
  ON public.pick_history
  FOR EACH ROW
  EXECUTE FUNCTION public.d165_pick_history_secondary_trg();

-- ============================================================================
-- One-shot backfill: recompute for every existing (player, game_date) group
-- that has 2+ non-synthetic process-games picks since 2026-04-25.
-- ============================================================================

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT player_name, game_date
    FROM public.pick_history
    WHERE is_synthetic = FALSE
      AND COALESCE(voided, FALSE) = FALSE
      AND source = 'process-games'
      AND game_date >= DATE '2026-04-25'
    GROUP BY player_name, game_date
    HAVING COUNT(*) >= 2
  LOOP
    PERFORM public.d165_recompute_secondary_market(r.player_name, r.game_date);
  END LOOP;
END $$;

-- ============================================================================
-- recommendations_cache — same pattern but simpler (Dashboard reads here).
-- ============================================================================

ALTER TABLE public.recommendations_cache
  ADD COLUMN IF NOT EXISTS is_secondary_market BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.recommendations_cache.is_secondary_market IS
  'D-165: TRUE for all picks of (player_name, game_date) except the highest-confidence row. Maintained by trigger.';

CREATE OR REPLACE FUNCTION public.d165_recompute_cache_secondary(
  p_player TEXT, p_game_date DATE
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_max_conf INT;
BEGIN
  SELECT MAX(confidence) INTO v_max_conf
  FROM public.recommendations_cache
  WHERE player_name = p_player AND game_date = p_game_date;

  IF v_max_conf IS NULL THEN RETURN; END IF;

  UPDATE public.recommendations_cache
  SET is_secondary_market = (confidence < v_max_conf)
  WHERE player_name = p_player
    AND game_date = p_game_date
    AND is_secondary_market <> (confidence < v_max_conf);
END;
$$;

CREATE OR REPLACE FUNCTION public.d165_cache_secondary_trg()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
  PERFORM public.d165_recompute_cache_secondary(NEW.player_name, NEW.game_date);
  IF TG_OP = 'UPDATE' THEN
    IF NEW.player_name IS DISTINCT FROM OLD.player_name
       OR NEW.game_date IS DISTINCT FROM OLD.game_date THEN
      PERFORM public.d165_recompute_cache_secondary(OLD.player_name, OLD.game_date);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS recommendations_cache_d165_secondary_trg ON public.recommendations_cache;
CREATE TRIGGER recommendations_cache_d165_secondary_trg
  AFTER INSERT OR UPDATE OF confidence, player_name, game_date
  ON public.recommendations_cache
  FOR EACH ROW
  EXECUTE FUNCTION public.d165_cache_secondary_trg();

-- One-shot backfill for cache too.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT player_name, game_date
    FROM public.recommendations_cache
    GROUP BY player_name, game_date
    HAVING COUNT(*) >= 2
  LOOP
    PERFORM public.d165_recompute_cache_secondary(r.player_name, r.game_date);
  END LOOP;
END $$;

COMMIT;

-- =============================================================================
-- ROLLBACK
-- =============================================================================
-- DROP TRIGGER IF EXISTS pick_history_d165_secondary_market_trg ON public.pick_history;
-- DROP TRIGGER IF EXISTS recommendations_cache_d165_secondary_trg ON public.recommendations_cache;
-- DROP FUNCTION IF EXISTS public.d165_pick_history_secondary_trg();
-- DROP FUNCTION IF EXISTS public.d165_cache_secondary_trg();
-- DROP FUNCTION IF EXISTS public.d165_recompute_secondary_market(TEXT, TEXT);
-- DROP FUNCTION IF EXISTS public.d165_recompute_cache_secondary(TEXT, TEXT);
-- DROP INDEX IF EXISTS pick_history_player_gdate_idx;
-- ALTER TABLE public.pick_history DROP COLUMN IF EXISTS is_secondary_market;
-- ALTER TABLE public.recommendations_cache DROP COLUMN IF EXISTS is_secondary_market;
