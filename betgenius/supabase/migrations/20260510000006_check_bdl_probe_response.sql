-- Check if the BDL probe response landed in net._http_response after pg_net timeout
DO $$
DECLARE
  v_row RECORD;
BEGIN
  RAISE NOTICE 'most-recent net._http_response rows (last 5):';
  FOR v_row IN
    SELECT id, status_code, error_msg, timed_out, created,
           LEFT(content::TEXT, 1500) AS body_excerpt
    FROM net._http_response
    ORDER BY created DESC
    LIMIT 5
  LOOP
    RAISE NOTICE '  id=% http=% timed_out=% err=% created=%',
      v_row.id, v_row.status_code, v_row.timed_out,
      COALESCE(v_row.error_msg, '(none)'), v_row.created;
    RAISE NOTICE '    body: %', v_row.body_excerpt;
  END LOOP;
END $$;
