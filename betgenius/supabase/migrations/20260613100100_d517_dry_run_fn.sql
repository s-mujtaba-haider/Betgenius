-- D-517 DRY-RUN — SQL re-score harness.
-- The function `d517_new_conf` computes the NEW confidence value a pick
-- WOULD HAVE GOTTEN under the proposed score_batter_line_hit_rate factor.
-- It is INVOKED ONLY in the dry-run validation queries below and never
-- writes to pick_history. Live scoring is unchanged.

-- The factor:
--   For batter markets with breakdown.last10_hit_rate_pct available:
--     l10 >= 70: factor =  +6
--     l10 >= 60: factor =  +3
--     l10 >= 50: factor =   0
--     l10 >= 40: factor =  -3
--     l10 >= 30: factor =  -6
--     l10 <  30: factor = -10
--   weighted = round(factor * 1.5) ≈ -15..+9
--   new_conf = clamp(old_conf + weighted, 0, 100)
--
-- Magnitudes:
--   +9 at l10 >= 70    → moderate reward for proven line-clearing
--   -15 at l10 < 30    → strong penalty for cold streaks (the Canzone class)
--
-- The dry-run does NOT re-apply D-467/D-140/D-479/D-509 caps; these caps
-- depend on FINAL conf values, but the new factor mostly DROPS conf — so
-- caps that previously fired keep firing at the same or lower thresholds,
-- and the comparison is conservative against the change.

CREATE OR REPLACE FUNCTION public.d517_new_conf(
  p_old_conf INTEGER,
  p_market   TEXT,
  p_pick_side TEXT,
  p_breakdown JSONB
)
RETURNS INTEGER LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_is_batter BOOLEAN;
  v_l10 NUMERIC;
  v_factor INTEGER;
  v_weight NUMERIC := 1.5;
  v_weighted INTEGER;
BEGIN
  -- Touch only batter markets (factor is batter-only by design)
  v_is_batter := p_market IS NOT NULL AND p_market LIKE 'batter_%';
  IF NOT v_is_batter THEN RETURN p_old_conf; END IF;

  -- Need the field present
  IF p_breakdown IS NULL OR NOT (p_breakdown ? 'last10_hit_rate_pct') THEN
    RETURN p_old_conf;
  END IF;

  v_l10 := (p_breakdown->>'last10_hit_rate_pct')::NUMERIC;

  v_factor := CASE
    WHEN v_l10 >= 70 THEN 6
    WHEN v_l10 >= 60 THEN 3
    WHEN v_l10 >= 50 THEN 0
    WHEN v_l10 >= 40 THEN -3
    WHEN v_l10 >= 30 THEN -6
    ELSE -10
  END;

  v_weighted := ROUND(v_factor * v_weight)::INTEGER;

  RETURN LEAST(100, GREATEST(0, p_old_conf + v_weighted));
END;
$$;

GRANT EXECUTE ON FUNCTION public.d517_new_conf(INTEGER, TEXT, TEXT, JSONB) TO PUBLIC;

DO $$ DECLARE v INTEGER;
BEGIN
  -- Smoke tests
  v := public.d517_new_conf(100, 'batter_total_bases', 'over', '{"last10_hit_rate_pct":40}'::jsonb);
  RAISE NOTICE '[D-517 smoke] Canzone-class (100 + l10=40 + tb): new_conf=% expected ~95-96', v;
  v := public.d517_new_conf(100, 'batter_total_bases', 'over', '{"last10_hit_rate_pct":20}'::jsonb);
  RAISE NOTICE '[D-517 smoke] Worst case (100 + l10=20 + tb):    new_conf=% expected ~85', v;
  v := public.d517_new_conf(100, 'batter_total_bases', 'over', '{"last10_hit_rate_pct":80}'::jsonb);
  RAISE NOTICE '[D-517 smoke] Strong hitter (100 + l10=80 + tb):  new_conf=% expected 100 (still clamped)', v;
  v := public.d517_new_conf(80, 'batter_rbis', 'over', '{"last10_hit_rate_pct":30}'::jsonb);
  RAISE NOTICE '[D-517 smoke] Med-high + low l10 (80 + l10=30):    new_conf=% expected ~71', v;
  v := public.d517_new_conf(60, 'game_side', 'home', '{}'::jsonb);
  RAISE NOTICE '[D-517 smoke] Non-batter (game_side):              new_conf=% expected 60 (untouched)', v;
  v := public.d517_new_conf(50, 'batter_hits', 'over', '{}'::jsonb);
  RAISE NOTICE '[D-517 smoke] Batter w/o breakdown field:          new_conf=% expected 50 (untouched)', v;
END $$;
