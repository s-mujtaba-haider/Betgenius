DO $$ DECLARE r RECORD; v_body text; v_len int; v_pos int; v_chunk text; BEGIN
  SELECT content::text INTO v_body FROM net._http_response WHERE id = 30546;
  v_len := length(v_body);
  RAISE NOTICE 'body length=%', v_len;
  -- Strip newlines and dump in chunks
  v_body := regexp_replace(v_body, E'[\\n\\r]+', ' ', 'g');
  v_len := length(v_body);
  v_pos := 1;
  WHILE v_pos <= v_len LOOP
    v_chunk := substring(v_body from v_pos for 400);
    RAISE NOTICE '  [pos %] %', v_pos, v_chunk;
    v_pos := v_pos + 400;
  END LOOP;
END $$;
