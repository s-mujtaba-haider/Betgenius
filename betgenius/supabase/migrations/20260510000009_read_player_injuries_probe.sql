-- Read full BDL player_injuries probe response in chunks.
DO $$
DECLARE
  v_body TEXT;
  v_chunk_size CONSTANT INTEGER := 400;
  v_pos INTEGER := 1;
  v_idx INTEGER := 1;
  v_total INTEGER;
  v_status INTEGER;
BEGIN
  SELECT content::TEXT, status_code INTO v_body, v_status
  FROM net._http_response
  WHERE id = 6182;
  IF v_body IS NULL THEN
    RAISE NOTICE 'no body for id=6182'; RETURN;
  END IF;
  RAISE NOTICE 'http_status=% body_len=% chars', v_status, LENGTH(v_body);
  v_total := CEIL(LENGTH(v_body)::NUMERIC / v_chunk_size);
  WHILE v_pos <= LENGTH(v_body) LOOP
    RAISE NOTICE 'CHUNK[%/%]: %', v_idx, v_total,
      REPLACE(REPLACE(SUBSTRING(v_body FROM v_pos FOR v_chunk_size), E'\n', '\n'), E'\r', '');
    v_pos := v_pos + v_chunk_size;
    v_idx := v_idx + 1;
  END LOOP;
END $$;
