-- D-306 Phase 3 fix — scan_task_hard_rules returned NULL on empty
-- violations (array_length on empty array returns NULL). Use cardinality.

CREATE OR REPLACE FUNCTION scan_task_hard_rules(p_prompt TEXT)
RETURNS TABLE (blocked BOOLEAN, violations TEXT[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_violations TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF p_prompt ~* '\bdeploy\s+to\s+(prod|production)\b' OR p_prompt ~* '\bvercel\s+--prod\b' THEN
    v_violations := array_append(v_violations, 'production_deploy_keyword');
  END IF;
  IF p_prompt ~* '\bALTER\s+(WEIGHTS|algorithm_weights)\b' OR p_prompt ~* 'UPDATE\s+algorithm_weights\b' THEN
    v_violations := array_append(v_violations, 'weight_mutation');
  END IF;
  IF p_prompt ~* 'UPDATE\s+pick_history\b' AND p_prompt !~* 'WHERE\s+id\s*=' THEN
    v_violations := array_append(v_violations, 'mass_pick_history_update');
  END IF;
  IF p_prompt ~* 'DELETE\s+FROM\s+pick_history\b' OR p_prompt ~* 'DELETE\s+FROM\s+recommendations_cache\b' THEN
    v_violations := array_append(v_violations, 'pick_deletion');
  END IF;
  IF p_prompt ~* '\bsupabase\s+functions\s+deploy\b.*(process-games|resolve-picks|fetch-odds|fetch-weather)' THEN
    v_violations := array_append(v_violations, 'critical_function_deploy');
  END IF;
  IF p_prompt ~* '\bDROP\s+TABLE\b' OR p_prompt ~* '\bTRUNCATE\s+\w' THEN
    v_violations := array_append(v_violations, 'irreversible_ddl');
  END IF;
  IF p_prompt ~* '\bgit\s+push\s+--force\b' OR p_prompt ~* '--no-verify' OR p_prompt ~* '--no-gpg-sign' THEN
    v_violations := array_append(v_violations, 'irreversible_git');
  END IF;
  IF p_prompt ~* '\b(stripe|billing|subscription|auth_user|users\s+table)\b' AND p_prompt ~* '(UPDATE|DELETE|INSERT|deploy)' THEN
    v_violations := array_append(v_violations, 'auth_or_payment_path');
  END IF;
  IF p_prompt ~* '\bbackfill.*(odds|outcomes).*api\b' THEN
    v_violations := array_append(v_violations, 'odds_api_credit_warning');
  END IF;

  RETURN QUERY SELECT cardinality(v_violations) > 0, v_violations;
END;
$$;
