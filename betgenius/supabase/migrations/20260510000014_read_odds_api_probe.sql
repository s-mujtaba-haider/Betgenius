-- Read Odds API probe response (request_id=6192) in chunks.
DO $$
DECLARE
  v_body TEXT;
  v_status INTEGER;
  v_timed_out BOOLEAN;
  v_err TEXT;
  v_chunk_size CONSTANT INTEGER := 400;
  v_pos INTEGER := 1;
  v_idx INTEGER := 1;
  v_total INTEGER;
BEGIN
  SELECT content::TEXT, status_code, timed_out, error_msg
  INTO v_body, v_status, v_timed_out, v_err
  FROM net._http_response WHERE id = 6192;

  IF v_body IS NULL THEN
    RAISE NOTICE 'id=6192 not landed yet (or null). status=% timed_out=% err=%',
      v_status, v_timed_out, COALESCE(v_err, '(none)');
    RETURN;
  END IF;

  RAISE NOTICE 'http_status=% timed_out=% body_len=%',
    v_status, v_timed_out, LENGTH(v_body);

  v_total := CEIL(LENGTH(v_body)::NUMERIC / v_chunk_size);
  WHILE v_pos <= LENGTH(v_body) LOOP
    RAISE NOTICE 'CHUNK[%/%]: %', v_idx, v_total,
      REPLACE(REPLACE(SUBSTRING(v_body FROM v_pos FOR v_chunk_size), E'\n', '\n'), E'\r', '');
    v_pos := v_pos + v_chunk_size;
    v_idx := v_idx + 1;
  END LOOP;
END $$;
