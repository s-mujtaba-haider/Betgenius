-- D-499-APPLY SHIP 2 step E — Check that process-games-mlb fired with the
-- new weights. Pulls the fn response + counts recommendations_cache rows
-- written since the PATCH timestamp.
DO $$
DECLARE
  v_patch_ts    TIMESTAMPTZ;
  v_status      INTEGER;
  v_content     TEXT;
  v_rec_cnt     INTEGER;
  v_latest_rec  TIMESTAMPTZ;
  r RECORD;
BEGIN
  -- Recall the PATCH timestamp (algorithm_weights.updated_at was set by D-499-APPLY)
  SELECT updated_at INTO v_patch_ts FROM public.algorithm_weights WHERE id = 1;
  RAISE NOTICE '[D-499-APPLY E] PATCH timestamp: %', v_patch_ts;

  -- Pull the response from net._http_response for request_id=10223
  FOR r IN
    SELECT status_code, content, error_msg, created
    FROM net._http_response WHERE id = 10223
  LOOP
    v_status := r.status_code;
    v_content := r.content;
    RAISE NOTICE '[D-499-APPLY E] process-games-mlb response: status=% created=% error=%',
      r.status_code, r.created, COALESCE(r.error_msg, '<none>');
    -- Surface key response fields if it succeeded
    IF r.status_code = 200 AND r.content IS NOT NULL THEN
      RAISE NOTICE '[D-499-APPLY E] response excerpt: %', substring(r.content, 1, 1500);
    ELSIF r.status_code IS NOT NULL THEN
      RAISE NOTICE '[D-499-APPLY E] non-200 body excerpt: %', substring(r.content, 1, 1000);
    END IF;
    EXIT;
  END LOOP;

  IF v_status IS NULL THEN
    RAISE NOTICE '[D-499-APPLY E] no response yet from request_id=10223 — fn still running OR write to net._http_response delayed';
  END IF;

  -- Count recommendations_cache rows written since the PATCH (these would be
  -- the new tick's scored picks; if any landed, they were scored with the
  -- new weights)
  SELECT count(*), max(created_at)
  INTO v_rec_cnt, v_latest_rec
  FROM public.recommendations_cache
  WHERE created_at > v_patch_ts;
  RAISE NOTICE '[D-499-APPLY E] recommendations_cache rows created after PATCH: % (latest: %)',
    v_rec_cnt, v_latest_rec;

  -- Show a sample of those rows
  IF v_rec_cnt > 0 THEN
    RAISE NOTICE '[D-499-APPLY E] sample post-PATCH rec_cache rows:';
    FOR r IN
      SELECT id, created_at, sport, player_name, prop_type, confidence
      FROM public.recommendations_cache
      WHERE created_at > v_patch_ts
      ORDER BY created_at DESC LIMIT 5
    LOOP
      RAISE NOTICE '  rec_id=% created=% sport=% player=% prop=% conf=%',
        r.id, r.created_at, r.sport, r.player_name, r.prop_type, r.confidence;
    END LOOP;
  END IF;

  -- Also pull the most-recent algorithm_weights.updated_at chain to confirm
  -- the PATCH is still in place and no later overwrite happened
  SELECT updated_at INTO v_patch_ts FROM public.algorithm_weights WHERE id = 1;
  RAISE NOTICE '[D-499-APPLY E] algorithm_weights.updated_at now: % (must match earlier echo)', v_patch_ts;
END $$;
