-- D-506 SHIP 4 — D-499 weight-apply watch on fresh resolved data.
--
-- D-499 (apply 2026-06-10 02:50 UTC): full 54-factor MLB optimizer applied
-- 7 weight changes targeting +0.34pp WR on the validate set (dry-run).
--
-- Watch plan (from D-499 apply doc):
--   1st (early signal):  ~30 resolved MLB conf>=60 picks → ±2-4pp around +0.34pp projection
--   2nd (firmer signal): ~100 resolved MLB conf>=60 picks → ±1-2pp around +0.34pp projection
--   Rollback threshold:  >5pp BELOW pre-apply baseline over 50+ picks

DO $$
DECLARE r RECORD; v_pre_baseline NUMERIC; v_post_n BIGINT; v_post_wr NUMERIC; v_pre_n BIGINT;
BEGIN
  -- Pre-apply baseline: MLB conf>=60 WR over 30 days prior to D-499 apply
  -- (game_date 2026-05-11 → 2026-06-09).
  SELECT count(*),
         ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0), 2)
    INTO v_pre_n, v_pre_baseline
    FROM public.pick_history_real
   WHERE sport = 'mlb' AND is_synthetic = false
     AND confidence >= 60
     AND game_date BETWEEN DATE '2026-05-11' AND DATE '2026-06-09'
     AND hit IS NOT NULL;
  RAISE NOTICE '[D-506 SHIP 4] D-499 pre-apply baseline (MLB conf>=60, 30d before apply):';
  RAISE NOTICE '  n=% WR=%', v_pre_n, v_pre_baseline;

  -- Post-apply sample: MLB conf>=60 picks from game_date >= 2026-06-10
  SELECT count(*),
         ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0), 2)
    INTO v_post_n, v_post_wr
    FROM public.pick_history_real
   WHERE sport = 'mlb' AND is_synthetic = false
     AND confidence >= 60
     AND game_date >= DATE '2026-06-10'
     AND hit IS NOT NULL;
  RAISE NOTICE '[D-506 SHIP 4] D-499 post-apply sample (MLB conf>=60, game_date>=6/10):';
  RAISE NOTICE '  n=% WR=%', v_post_n, v_post_wr;

  -- Rollback check
  IF v_post_n >= 50 AND v_pre_baseline IS NOT NULL AND v_post_wr IS NOT NULL
     AND v_post_wr < (v_pre_baseline - 5) THEN
    RAISE NOTICE '[D-506 SHIP 4] D-499 ROLLBACK TRIGGERED — post WR=% vs pre=% (delta < -5pp on n=%)',
      v_post_wr, v_pre_baseline, v_post_n;
  ELSIF v_post_n >= 50 THEN
    RAISE NOTICE '[D-506 SHIP 4] D-499 no rollback signal (post=% vs pre=%, delta within band on n=%)',
      v_post_wr, v_pre_baseline, v_post_n;
  ELSIF v_post_n >= 30 THEN
    RAISE NOTICE '[D-506 SHIP 4] D-499 early signal only (n=% < 50 firm threshold)', v_post_n;
  ELSE
    RAISE NOTICE '[D-506 SHIP 4] D-499 still TOO-EARLY — n=% < 30', v_post_n;
  END IF;

  -- Bonus: pre/post by confidence tier
  RAISE NOTICE '[D-506 SHIP 4] D-499 confidence-tier breakdown:';
  FOR r IN
    SELECT CASE WHEN confidence >= 80 THEN 'ELITE/STRONG'
                WHEN confidence >= 70 THEN 'GOOD' ELSE 'LEAN' END AS tier,
           CASE WHEN game_date >= DATE '2026-06-10' THEN 'post' ELSE 'pre' END AS era,
           count(*) AS n,
           ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0), 2) AS wr
    FROM public.pick_history_real
   WHERE sport = 'mlb' AND is_synthetic = false
     AND confidence >= 60
     AND game_date BETWEEN DATE '2026-05-11' AND DATE '2026-06-15'
     AND hit IS NOT NULL
   GROUP BY tier, era ORDER BY tier, era
  LOOP
    RAISE NOTICE '  tier=% era=% n=% wr=%', r.tier, r.era, r.n, r.wr;
  END LOOP;
END $$;
