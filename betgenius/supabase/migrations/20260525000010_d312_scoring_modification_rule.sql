-- D-312 — close hard-rules gap for scoring-code modification tasks.
--
-- D-312 pre-scan found 3 of 12 approval-required tasks (T6/T7/T8) slipped
-- through the existing rules because they modify scoring code without
-- using "deploy" or "update" keywords:
--   T6 "Refactor scoring_mlb_v2.ts to read weights from algorithm_weights"
--   T7 "invert the factor sign OR drop from scoring entirely"
--   T8 "Retire confirmed neutral factors from scoring ... remove from scoring code"
--
-- Existing rules require `deploy + critical_function` or `update + algorithm_weights`.
-- The new pattern is "modify/transform/remove scoring logic" which has neither.
--
-- New rule fires on the destructive verbs paired with "scoring" or "factor":
--   - `refactor scoring`         (T6 catch)
--   - `drop from scoring`        (T7 catch)
--   - `remove from scoring`      (T8 catch)
--   - `retire ... factor`        (T8 catch)
--   - `invert the factor`        (T7 catch)
--
-- False-positive check (T10 "wires NEW factors", T12 generic) — none of
-- these patterns appear in T10/T12 prompts. T10 uses "Wire each one
-- factor at a time" which doesn't match any pattern above.
--
-- Rollback: re-apply 20260525000007 (which is the prior CREATE OR REPLACE
-- of scan_task_hard_rules and contains all rules MINUS this new one).

CREATE OR REPLACE FUNCTION scan_task_hard_rules(p_prompt TEXT)
RETURNS TABLE (blocked BOOLEAN, violations TEXT[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_violations TEXT[] := ARRAY[]::TEXT[];
  p_lower TEXT := lower(p_prompt);
BEGIN
  -- Production deploy
  IF p_lower LIKE '%deploy%' AND (p_lower LIKE '%production%' OR p_lower LIKE '%prod%' OR p_lower LIKE '%vercel%--prod%') THEN
    v_violations := array_append(v_violations, 'production_deploy_keyword');
  END IF;

  -- Weight mutation (existing — v4)
  IF p_lower LIKE '%alter weights%' OR p_lower LIKE '%alter algorithm_weights%' OR (p_lower LIKE '%update%' AND p_lower LIKE '%algorithm_weights%') THEN
    v_violations := array_append(v_violations, 'weight_mutation');
  END IF;
  IF p_lower LIKE '%alter table%algorithm_weights%' OR p_lower LIKE '%alter table % algorithm_weights%' THEN
    v_violations := array_append(v_violations, 'weight_mutation');
  END IF;

  -- Mass pick_history update (no WHERE id=)
  IF p_prompt ~* 'UPDATE\s+pick_history' AND p_prompt !~* 'WHERE\s+id\s*=' THEN
    v_violations := array_append(v_violations, 'mass_pick_history_update');
  END IF;

  -- Pick/recs deletion
  IF p_lower LIKE '%delete from pick_history%' OR p_lower LIKE '%delete from recommendations_cache%' THEN
    v_violations := array_append(v_violations, 'pick_deletion');
  END IF;

  -- Critical function deploy
  IF p_lower LIKE '%deploy%' AND (
    p_lower LIKE '%process-games-mlb%' OR p_lower LIKE '%process-games%' OR
    p_lower LIKE '%resolve-picks%' OR p_lower LIKE '%fetch-odds%' OR
    p_lower LIKE '%fetch-weather%' OR p_lower LIKE '%scoring_mlb%'
  ) THEN
    v_violations := array_append(v_violations, 'critical_function_deploy');
  END IF;

  -- Irreversible DDL
  IF p_lower LIKE '%drop table%' OR p_lower LIKE '%truncate %' OR p_lower LIKE '%truncate.%' THEN
    v_violations := array_append(v_violations, 'irreversible_ddl');
  END IF;

  -- Irreversible git
  IF p_lower LIKE '%--force%' OR p_lower LIKE '%--no-verify%' OR p_lower LIKE '%--no-gpg-sign%' THEN
    v_violations := array_append(v_violations, 'irreversible_git');
  END IF;

  -- Auth/payment path
  IF (p_lower LIKE '%stripe%' OR p_lower LIKE '%billing%' OR p_lower LIKE '%subscription%' OR p_lower LIKE '%auth_user%')
     AND (p_lower LIKE '%update%' OR p_lower LIKE '%delete%' OR p_lower LIKE '%insert%' OR p_lower LIKE '%deploy%') THEN
    v_violations := array_append(v_violations, 'auth_or_payment_path');
  END IF;

  -- Odds API credit warning
  IF p_lower LIKE '%backfill%' AND (p_lower LIKE '%odds api%' OR p_lower LIKE '%odds-api%' OR p_lower LIKE '%paid odds%') THEN
    v_violations := array_append(v_violations, 'odds_api_credit_warning');
  END IF;

  -- D-312 NEW: scoring-code modification (destructive verbs without "deploy")
  -- Catches "refactor scoring_mlb", "drop from scoring", "remove from scoring",
  -- "retire ... factor", "invert the factor". These all modify live scoring
  -- logic and require CEO approval.
  IF p_lower LIKE '%refactor scoring%'
     OR p_lower LIKE '%drop from scoring%'
     OR p_lower LIKE '%remove from scoring%'
     OR p_lower LIKE '%invert the factor%'
     OR (p_lower LIKE '%retire%' AND p_lower LIKE '%factor%')
  THEN
    v_violations := array_append(v_violations, 'scoring_code_modification');
  END IF;

  RETURN QUERY SELECT cardinality(v_violations) > 0, v_violations;
END;
$$;
