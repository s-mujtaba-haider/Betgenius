-- Read v2 paginated probe response (request_id=6185).
DO $$
DECLARE
  v_body TEXT;
  v_chunk_size CONSTANT INTEGER := 400;
  v_pos INTEGER := 1;
  v_idx INTEGER := 1;
  v_total INTEGER;
  v_status INTEGER;
  v_timed_out BOOLEAN;
  v_err TEXT;
BEGIN
  SELECT content::TEXT, status_code, timed_out, error_msg
  INTO v_body, v_status, v_timed_out, v_err
  FROM net._http_response WHERE id = 6185;

  IF v_body IS NULL THEN
    RAISE NOTICE 'id=6185 not landed yet (or null content). status=% timed_out=% err=%',
      v_status, v_timed_out, COALESCE(v_err, '(none)');
    RETURN;
  END IF;

  RAISE NOTICE 'http_status=% timed_out=% body_len=% chars',
    v_status, v_timed_out, LENGTH(v_body);

  v_total := CEIL(LENGTH(v_body)::NUMERIC / v_chunk_size);
  WHILE v_pos <= LENGTH(v_body) LOOP
    RAISE NOTICE 'CHUNK[%/%]: %', v_idx, v_total,
      REPLACE(REPLACE(SUBSTRING(v_body FROM v_pos FOR v_chunk_size), E'\n', '\n'), E'\r', '');
    v_pos := v_pos + v_chunk_size;
    v_idx := v_idx + 1;
  END LOOP;
END $$;
