-- D-330 read-only: log last 3 net._http_response rows to verify dispatcher cron is
-- actually authenticating (vs the silently-401 pattern D-313 found with broken GUC).
DO $$
DECLARE v_row RECORD;
BEGIN
  RAISE NOTICE '[D-330] last 5 net._http_response rows:';
  FOR v_row IN
    SELECT created::text AS created, status_code, COALESCE(error_msg,'(none)') AS error_msg, COALESCE(content::text, '(empty)') AS content
    FROM net._http_response
    ORDER BY created DESC
    LIMIT 5
  LOOP
    RAISE NOTICE '  % | http=% | err=% | content=%', v_row.created, v_row.status_code, v_row.error_msg, LEFT(v_row.content, 200);
  END LOOP;
END $$;
