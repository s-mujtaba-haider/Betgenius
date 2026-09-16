-- ============================================================================
-- Migration : 20260515000006_d189_w_opp_defense_activate.sql
-- Date      : 2026-05-15
-- Task      : D-189 — w_opp_defense activated from 0.0 -> 1.0.
--
-- DOCUMENTATION ONLY. The actual UPDATE is applied via service-role PATCH on
-- algorithm_weights (id=1) per CEO direct workflow:
--   curl -X PATCH .../rest/v1/algorithm_weights?id=eq.1 \
--     -d '{"w_opp_defense": 1.0}'
--
-- This migration is the audit-trail record so the change is visible in
-- supabase/migrations/. Re-applied DO-block is idempotent (it overwrites
-- to 1.0 even if a prior session moved it — that is the design: this
-- migration declares "intended value at this point in history").
--
-- Context:
--   D-186 Phase 2 (May 15, 2026) wired BDL GOAT per-position defensive
--   rating into scoreOneSide via the helpers pattern. Rebounds + assists
--   prop scoring now consume defensive_rebound_percentage / assist_percentage
--   per (opp_team, opp_position) from cache_team_advanced_stats_by_position.
--
--   Prior to D-186, the opp_defense factor relied on ESPN PPG-allowed (which
--   actually returned team OWN PPG — wrong-data label drift). w_opp_defense
--   was zeroed in a prior session to neutralize the bad signal. With real
--   data now flowing, weight needs to be non-zero for the factor to
--   contribute to confidence at all (confidence = sum(score_i * w_i)).
--
--   Starting value 1.0 matches the default factor weight pattern (cf.
--   getDefaultWeights() in _shared/scoring.ts). Retune via §19.3 manual
--   UPDATE after ~2 weeks of accumulated fire-rate + WR-delta data on
--   live picks (D-170 Path C retune pattern: ship with conservative
--   starting weight, gather signal, retune empirically).
--
-- Rollback:
--   UPDATE public.algorithm_weights SET w_opp_defense = 0.0 WHERE id = 1;
-- ============================================================================

DO $$
DECLARE
  v_before NUMERIC;
  v_after  NUMERIC;
BEGIN
  SELECT w_opp_defense INTO v_before FROM public.algorithm_weights WHERE id = 1;
  UPDATE public.algorithm_weights SET w_opp_defense = 1.0 WHERE id = 1;
  SELECT w_opp_defense INTO v_after FROM public.algorithm_weights WHERE id = 1;
  RAISE NOTICE 'D-189 w_opp_defense: % -> %', v_before, v_after;
END $$;
