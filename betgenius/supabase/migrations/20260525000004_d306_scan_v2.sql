-- D-306 Phase 3 v2 — broader keyword-pair scanner. Initial regex was
-- too strict (e.g., "Deploy a new edge function to production" didn't
-- match \bdeploy\s+to\s+production\b because of intervening words).

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
  -- Category 1: keyword-pair blocked (uses lower-case substring matching)
  IF p_lower LIKE '%deploy%' AND (p_lower LIKE '%production%' OR p_lower LIKE '%prod %' OR p_lower LIKE '% prod' OR p_lower LIKE '%vercel%--prod%') THEN
    v_violations := array_append(v_violations, 'production_deploy_keyword');
  END IF;

  IF p_lower LIKE '%alter weights%' OR p_lower LIKE '%alter algorithm_weights%' OR (p_lower LIKE '%update%' AND p_lower LIKE '%algorithm_weights%') THEN
    v_violations := array_append(v_violations, 'weight_mutation');
  END IF;

  IF p_prompt ~* '\bUPDATE\s+pick_history\b' AND p_prompt !~* '\bWHERE\s+id\s*=' THEN
    v_violations := array_append(v_violations, 'mass_pick_history_update');
  END IF;

  IF p_prompt ~* '\bDELETE\s+FROM\s+pick_history\b' OR p_prompt ~* '\bDELETE\s+FROM\s+recommendations_cache\b' THEN
    v_violations := array_append(v_violations, 'pick_deletion');
  END IF;

  -- Critical function deploy: keyword "deploy" + any critical fn name
  IF p_lower LIKE '%deploy%' AND (
    p_lower LIKE '%process-games-mlb%' OR p_lower LIKE '%process-games%' OR
    p_lower LIKE '%resolve-picks%' OR p_lower LIKE '%fetch-odds%' OR
    p_lower LIKE '%fetch-weather%' OR p_lower LIKE '%scoring_mlb%'
  ) THEN
    v_violations := array_append(v_violations, 'critical_function_deploy');
  END IF;

  -- Category 4: irreversible
  IF p_prompt ~* '\bDROP\s+TABLE\b' OR p_prompt ~* '\bTRUNCATE\s+\w' THEN
    v_violations := array_append(v_violations, 'irreversible_ddl');
  END IF;

  IF p_prompt ~* '--force' OR p_lower LIKE '%--no-verify%' OR p_lower LIKE '%--no-gpg-sign%' THEN
    v_violations := array_append(v_violations, 'irreversible_git');
  END IF;

  -- Category 3: safety paths
  IF (p_lower LIKE '%stripe%' OR p_lower LIKE '%billing%' OR p_lower LIKE '%subscription%' OR p_lower LIKE '%auth_user%')
     AND (p_lower LIKE '%update%' OR p_lower LIKE '%delete%' OR p_lower LIKE '%insert%' OR p_lower LIKE '%deploy%') THEN
    v_violations := array_append(v_violations, 'auth_or_payment_path');
  END IF;

  -- Category 2: resource (signal-only at scan; execution enforces)
  IF (p_lower LIKE '%backfill%' AND (p_lower LIKE '%odds api%' OR p_lower LIKE '%odds-api%' OR p_lower LIKE '%paid odds%')) THEN
    v_violations := array_append(v_violations, 'odds_api_credit_warning');
  END IF;

  RETURN QUERY SELECT cardinality(v_violations) > 0, v_violations;
END;
$$;
