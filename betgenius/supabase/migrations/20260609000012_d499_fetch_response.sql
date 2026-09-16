-- D-499 fetch the optimizer dry-run response from net._http_response and
-- surface key proposal metrics. Also AFTER snapshot of algorithm_weights
-- to prove unchanged (dry-run verification).
DO $$
DECLARE
  v_request_id BIGINT := 10063;  -- captured from D-499 trigger migration
  r RECORD;
  v_status     INTEGER;
  v_content    TEXT;
  v_apply      BOOLEAN;
  v_write_st   INTEGER;
  v_train_base NUMERIC;
  v_train_fin  NUMERIC;
  v_val_base   NUMERIC;
  v_val_fin    NUMERIC;
  v_delta_tr   NUMERIC;
  v_delta_val  NUMERIC;
  v_class_cnt  JSONB;
  v_changes    JSONB;
BEGIN
  -- Pull the response row from pg_net
  FOR r IN
    SELECT status_code, content, error_msg, created
    FROM net._http_response WHERE id = v_request_id
  LOOP
    v_status := r.status_code;
    v_content := r.content;
    RAISE NOTICE '[D-499 RESPONSE] request_id=% status_code=% created=% error=%',
      v_request_id, r.status_code, r.created, COALESCE(r.error_msg, '<none>');
    EXIT;  -- only one row expected
  END LOOP;

  IF v_status IS NULL THEN
    RAISE NOTICE '[D-499 RESPONSE] no row in net._http_response yet for request_id=% — response not landed', v_request_id;
    RETURN;
  END IF;

  IF v_status >= 400 THEN
    RAISE NOTICE '[D-499 RESPONSE ERROR] HTTP % body excerpt: %', v_status, substring(v_content, 1, 800);
    RETURN;
  END IF;

  -- Parse the JSON response (the optimizer returns a structured success payload)
  v_apply        := (v_content::jsonb ->> 'apply')::boolean;
  v_write_st     := (v_content::jsonb ->> 'write_status')::integer;
  v_train_base   := ((v_content::jsonb -> 'baselines' -> 'train') ->> 'objective_hit_rate')::numeric;
  v_train_fin    := ((v_content::jsonb -> 'final' -> 'train') ->> 'objective_hit_rate')::numeric;
  v_val_base     := ((v_content::jsonb -> 'baselines' -> 'validate') ->> 'objective_hit_rate')::numeric;
  v_val_fin      := ((v_content::jsonb -> 'final' -> 'validate') ->> 'objective_hit_rate')::numeric;
  v_delta_tr     := (v_content::jsonb ->> 'delta_train_objective_hr')::numeric;
  v_delta_val    := (v_content::jsonb ->> 'delta_validate_objective_hr')::numeric;
  v_class_cnt    := v_content::jsonb -> 'classification_counts';
  v_changes      := v_content::jsonb -> 'apply_changes';

  RAISE NOTICE '[D-499 PROPOSAL] apply=% (must be FALSE)  write_status=% (must be NULL)', v_apply, v_write_st;
  RAISE NOTICE '[D-499 PROPOSAL] train baseline HR=%  → final=%  delta=%',
    v_train_base, v_train_fin, v_delta_tr;
  RAISE NOTICE '[D-499 PROPOSAL] validate baseline HR=%  → final=%  delta=%',
    v_val_base, v_val_fin, v_delta_val;
  RAISE NOTICE '[D-499 PROPOSAL] classification_counts=%', v_class_cnt;
  RAISE NOTICE '[D-499 PROPOSAL] apply_changes (proposed deltas) ↓';

  -- Enumerate apply_changes — JSON key is "column" (reserved word); access
  -- via jsonb-> extraction loop instead of jsonb_to_recordset AS clause.
  FOR r IN
    SELECT
      v ->> 'column'        AS col_name,
      v ->> 'market'        AS market,
      v ->> 'era'           AS era,
      (v ->> 'initial')::numeric    AS initial,
      (v ->> 'final')::numeric      AS final_v,
      v ->> 'direction'     AS direction,
      (v ->> 'magnitude_pct')::numeric AS magnitude_pct
    FROM jsonb_array_elements(v_changes) AS v
  LOOP
    RAISE NOTICE '  % (%, %): % → %  [% %s]',
      r.col_name, r.market, r.era,
      r.initial, r.final_v,
      r.direction, COALESCE(round(r.magnitude_pct * 100, 1)::text || '%', 'n/a');
  END LOOP;

  -- Per-weight log: just dump the JSON for offline analysis (next migration will summarize)
  RAISE NOTICE '[D-499 PER_WEIGHT_LOG_JSON] %', substring((v_content::jsonb -> 'per_weight_log')::text, 1, 4000);

  -- AFTER snapshot of all 54 weight cols — must match BEFORE (proves dry-run)
  RAISE NOTICE '[D-499 AFTER] full algorithm_weights row id=1 (compare to BEFORE_ROW_JSON):';
  FOR r IN
    SELECT row_to_json(algorithm_weights) AS j FROM algorithm_weights WHERE id = 1
  LOOP
    RAISE NOTICE 'AFTER_ROW_JSON %', r.j;
  END LOOP;
END $$;
