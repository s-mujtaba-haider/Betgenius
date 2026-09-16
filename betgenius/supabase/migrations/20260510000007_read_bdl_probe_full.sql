-- Read full BDL probe response body in chunks (NOTICE truncates long strings).
DO $$
DECLARE
  v_body TEXT;
  v_chunk_size CONSTANT INTEGER := 400;
  v_pos INTEGER := 1;
  v_idx INTEGER := 1;
  v_total INTEGER;
BEGIN
  SELECT content::TEXT INTO v_body
  FROM net._http_response
  WHERE id = 6181;

  IF v_body IS NULL THEN
    RAISE NOTICE 'no body for id=6181';
    RETURN;
  END IF;

  v_total := CEIL(LENGTH(v_body)::NUMERIC / v_chunk_size);
  RAISE NOTICE 'body length: % chars, splitting into % chunks', LENGTH(v_body), v_total;

  WHILE v_pos <= LENGTH(v_body) LOOP
    RAISE NOTICE 'CHUNK[%/%]: %', v_idx, v_total,
      REPLACE(REPLACE(SUBSTRING(v_body FROM v_pos FOR v_chunk_size), E'\n', '\n'), E'\r', '');
    v_pos := v_pos + v_chunk_size;
    v_idx := v_idx + 1;
  END LOOP;
END $$;
