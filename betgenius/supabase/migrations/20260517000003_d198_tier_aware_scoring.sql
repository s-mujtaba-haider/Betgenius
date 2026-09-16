-- D-198 — Tier-Aware Scoring (Tier 4 #11) infrastructure.
--
-- Creates `algorithm_weights_tier_modifiers` table that holds per-tier
-- multipliers on each scoring factor. The intent (per framework §4.10 +
-- Task 1.1 WR-comparison findings) is to let Elite-tier picks weight
-- recent_form / market_conf more heavily and Lean-tier picks lean on
-- season hit rate + consistency. The HEAD of this ship seeds every
-- (tier, factor) combination at multiplier=1.0 — IDENTITY default, ZERO
-- behavior change — so the table + RPC + audit column infrastructure
-- ships cleanly. Subsequent §19.3-gated D-records will tune individual
-- multipliers as calibration data accumulates.
--
-- §1.17 audit:
--   - New table, no writer-path implications (read-only from scoring code)
--   - RLS: read-all to authed, write service-role only
--   - PRIMARY KEY (tier, factor_name) guarantees one multiplier per cell
--
-- §1.14 N/A — no views touched.
-- §1.12 verification — paired with 20260517000006_d198_verification.sql.

CREATE TABLE IF NOT EXISTS public.algorithm_weights_tier_modifiers (
  tier         TEXT          NOT NULL,
  factor_name  TEXT          NOT NULL,
  multiplier   NUMERIC       NOT NULL DEFAULT 1.0 CHECK (multiplier >= 0 AND multiplier <= 5),
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  notes        TEXT,
  PRIMARY KEY (tier, factor_name),
  CONSTRAINT awtm_tier_valid CHECK (tier IN ('elite','strong','good','lean','pass'))
);

CREATE INDEX IF NOT EXISTS idx_awtm_tier ON public.algorithm_weights_tier_modifiers (tier);

-- RLS — read-all to authed, write service-role only.
ALTER TABLE public.algorithm_weights_tier_modifiers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS awtm_select_authed ON public.algorithm_weights_tier_modifiers;
CREATE POLICY awtm_select_authed ON public.algorithm_weights_tier_modifiers
  FOR SELECT TO authenticated USING (true);

-- Seed: every (tier, factor) combo at multiplier=1.0 (identity).
-- Factors enumerated to match `_shared/scoring.ts` weight keys
-- (ScoringWeights interface). Maintainers MUST extend this seed when
-- adding new factors per Cardinal Rule §1.17.
INSERT INTO public.algorithm_weights_tier_modifiers (tier, factor_name, multiplier, notes)
SELECT t.tier, f.factor_name, 1.0, 'D-198 identity seed (1.0 multiplier; no behavior change)'
FROM (VALUES ('elite'), ('strong'), ('good'), ('lean'), ('pass')) AS t(tier)
CROSS JOIN (VALUES
  ('l5'), ('l10'), ('season'), ('floorCeiling'), ('recentForm'),
  ('homeAway'), ('rest'), ('b2b'), ('minutesTrend'), ('pace'),
  ('oppDefense'), ('propType'), ('zScore'), ('roleChange'),
  ('vigFilter'), ('usgRate'), ('regression'), ('marketConf'),
  ('haSplit'), ('minutesFloor'), ('consistency'), ('staleData'),
  ('playerInjury'), ('lowMinRisk'), ('blowoutRisk'), ('lineMovement')
) AS f(factor_name)
ON CONFLICT (tier, factor_name) DO NOTHING;

COMMENT ON TABLE public.algorithm_weights_tier_modifiers IS
  'D-198 Tier 4 #11 Tier-Aware Scoring. effective_weight = base_weight × multiplier(tier, factor). Identity (1.0) on initial ship; tune via §19.3 manual UPDATE after calibration data accumulates. See migration 20260517000003_d198_tier_aware_scoring.sql.';

COMMENT ON COLUMN public.algorithm_weights_tier_modifiers.multiplier IS
  'Range 0-5. Default 1.0 = identity (no behavior change). Tune via §19.3 manual UPDATE; see Task 1.1 WR-comparison report for initial calibration data.';
