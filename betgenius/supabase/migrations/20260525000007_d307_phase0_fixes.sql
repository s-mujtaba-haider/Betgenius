-- D-307 Phase 0 — fix 2 gaps from D-307-precheck.
--
-- Gap 1: ALTER TABLE algorithm_weights not blocked.
--   v3 rule checked 'alter weights'/'alter algorithm_weights' but missed
--   the more common 'ALTER TABLE algorithm_weights' DDL phrasing.
--   This affects ADD COLUMN, DROP COLUMN, RENAME COLUMN, all of which
--   can be destructive.

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

  -- D-307 Phase 0: weight_mutation rule extended to catch ALTER TABLE
  -- algorithm_weights ... (the DDL phrasing missed in v3).
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

  RETURN QUERY SELECT cardinality(v_violations) > 0, v_violations;
END;
$$;
