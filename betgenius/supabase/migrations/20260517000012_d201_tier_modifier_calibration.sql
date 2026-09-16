-- D-201 (Batch 2 Task 2.3) — Tier-Aware Scoring real-multiplier calibration.
--
-- Replaces D-198 identity defaults (all 1.0) with data-driven values
-- informed by Batch 1 Task 1.1 + Batch 2 Task 2.1 cross-tab findings.
--
-- KEY EMPIRICAL INPUTS:
--   - Kelly fraction is the dominant WR predictor (40%+ Kelly = 87.1%
--     vs algo tier alone in same range)
--   - 70-79 "trap tier" pathology: WR 53.0% on 60+ subset (Lean 60-69
--     WR is HIGHER at 57.4%) → Good tier needs heavier season_hit_rate
--     weight + lower recent_form weight (hot-streak chase pathology
--     per framework §15.7 Failure Mode A)
--   - AI verdict at Strong+/LEAN cohort: 71.4% WR vs Strong+/TAKE 63.5%
--     → market_conf factor (which proxies for the AI's "this line is
--     mispriced" signal) deserves heavier weight at Strong+ tiers
--   - Elite tier small-n (10) WR 80% → trust recency signal more (recent_form)
--   - Lean tier surprisingly strong (n=1,432, 57.8% WR) → trust season +
--     consistency more
--
-- CONSERVATIVE RANGE: all multipliers within 0.7-1.4x. Larger swings
-- deferred until 4+ weeks of post-D-201 calibration_snapshots accumulate.
--
-- ROLLBACK: single SQL — UPDATE algorithm_weights_tier_modifiers
-- SET multiplier = 1.0 WHERE multiplier != 1.0; resets to identity.
--
-- WALK-FORWARD VALIDATION: post-apply rescore on the full backfill
-- cohort using D-198 confidence_pre_tier_aware audit column produces
-- empirical pre/post tier-WR delta. If any tier WR drops >3pp → revert.

BEGIN;

-- Helper: bulk-update one tier's modifiers in a single statement.
-- Each row gets the same updated_at + notes for auditability.

-- ELITE (90+): recency-weighted; trust L5 + market signal; downweight season
UPDATE public.algorithm_weights_tier_modifiers
SET multiplier = CASE factor_name
  WHEN 'l5' THEN 1.2
  WHEN 'recentForm' THEN 1.3
  WHEN 'marketConf' THEN 1.2
  WHEN 'season' THEN 0.8
  WHEN 'staleData' THEN 1.2  -- penalize stale data harder at Elite (high-trust label needs current data)
  ELSE 1.0
END,
notes = 'D-201 Batch 2 Task 2.3: recency-weighted Elite tier (small-n high-WR cohort; trust L5 + market signal)',
updated_at = NOW()
WHERE tier = 'elite';

-- STRONG (80-89): balanced; small ups on market_conf + L5; downweight
-- stale_data slightly (Strong+ picks already pre-filtered for freshness)
UPDATE public.algorithm_weights_tier_modifiers
SET multiplier = CASE factor_name
  WHEN 'l5' THEN 1.1
  WHEN 'marketConf' THEN 1.2
  WHEN 'recentForm' THEN 1.1
  WHEN 'staleData' THEN 0.9
  ELSE 1.0
END,
notes = 'D-201 Batch 2 Task 2.3: balanced Strong tier with market_conf + recency tilt (Task 2.1 cross-tab Strong+/LEAN 71% finding)',
updated_at = NOW()
WHERE tier = 'strong';

-- GOOD (70-79): "trap tier" per Task 1.1 — heavily downweight recent_form
-- (hot-streak chase), upweight season (trust long-run signal), upweight
-- vig_filter (Kelly-zero pathology) and opp_defense (matchup matters more
-- at this tier where the algo gets fooled by inflated recent stats)
UPDATE public.algorithm_weights_tier_modifiers
SET multiplier = CASE factor_name
  WHEN 'recentForm' THEN 0.8
  WHEN 'l5' THEN 0.9
  WHEN 'season' THEN 1.3
  WHEN 'vigFilter' THEN 1.2
  WHEN 'oppDefense' THEN 1.1
  WHEN 'consistency' THEN 1.2
  ELSE 1.0
END,
notes = 'D-201 Batch 2 Task 2.3: Good tier "trap" remediation per Task 1.1 — downweight recency (hot-streak chase / Failure Mode A), upweight season + matchup + consistency',
updated_at = NOW()
WHERE tier = 'good';

-- LEAN (60-69): season + consistency dominant; downweight recent_form
-- and pace; trust regression more
UPDATE public.algorithm_weights_tier_modifiers
SET multiplier = CASE factor_name
  WHEN 'season' THEN 1.4
  WHEN 'consistency' THEN 1.3
  WHEN 'recentForm' THEN 0.7
  WHEN 'pace' THEN 0.9
  WHEN 'regression' THEN 1.2
  WHEN 'l5' THEN 0.8
  ELSE 1.0
END,
notes = 'D-201 Batch 2 Task 2.3: Lean tier — long-run signal dominant per Task 1.1 (n=1,432, 57.8% WR)',
updated_at = NOW()
WHERE tier = 'lean';

-- PASS (<60): no change (picks not displayed anyway, no value tuning)
-- Identity preserved.

-- Verification: count non-identity multipliers + breakdown by tier
DO $$
DECLARE
  total_nonidentity INT;
  elite_n INT;
  strong_n INT;
  good_n INT;
  lean_n INT;
  pass_n INT;
BEGIN
  SELECT COUNT(*) INTO total_nonidentity FROM public.algorithm_weights_tier_modifiers
    WHERE multiplier <> 1.0;
  SELECT COUNT(*) INTO elite_n FROM public.algorithm_weights_tier_modifiers
    WHERE tier = 'elite' AND multiplier <> 1.0;
  SELECT COUNT(*) INTO strong_n FROM public.algorithm_weights_tier_modifiers
    WHERE tier = 'strong' AND multiplier <> 1.0;
  SELECT COUNT(*) INTO good_n FROM public.algorithm_weights_tier_modifiers
    WHERE tier = 'good' AND multiplier <> 1.0;
  SELECT COUNT(*) INTO lean_n FROM public.algorithm_weights_tier_modifiers
    WHERE tier = 'lean' AND multiplier <> 1.0;
  SELECT COUNT(*) INTO pass_n FROM public.algorithm_weights_tier_modifiers
    WHERE tier = 'pass' AND multiplier <> 1.0;
  RAISE NOTICE 'D-201 APPLY: % non-identity multipliers total — elite=% strong=% good=% lean=% pass=%',
    total_nonidentity, elite_n, strong_n, good_n, lean_n, pass_n;
END $$;

COMMIT;
