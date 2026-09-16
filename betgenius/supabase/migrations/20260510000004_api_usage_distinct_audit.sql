-- Broader audit of api_usage to confirm BDL tracking presence/absence.
DO $$
DECLARE
  v_row RECORD;
BEGIN
  RAISE NOTICE 'distinct function_name values in api_usage last 7 days:';
  FOR v_row IN
    SELECT function_name, COUNT(*) AS hits, MIN(called_at) AS first_seen, MAX(called_at) AS last_seen
    FROM api_usage
    WHERE called_at >= NOW() - INTERVAL '7 days'
    GROUP BY function_name
    ORDER BY hits DESC
  LOOP
    RAISE NOTICE '  function_name=% hits=% first=% last=%',
      v_row.function_name, v_row.hits, v_row.first_seen, v_row.last_seen;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'distinct endpoint values in api_usage last 7 days:';
  FOR v_row IN
    SELECT endpoint, COUNT(*) AS hits
    FROM api_usage
    WHERE called_at >= NOW() - INTERVAL '7 days'
    GROUP BY endpoint
    ORDER BY hits DESC
  LOOP
    RAISE NOTICE '  endpoint=% hits=%', v_row.endpoint, v_row.hits;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'rows with bdl/balldontlie/injuries in any text field (last 7 days):';
  FOR v_row IN
    SELECT function_name, endpoint, COUNT(*) AS hits
    FROM api_usage
    WHERE called_at >= NOW() - INTERVAL '7 days'
      AND (LOWER(function_name) LIKE '%bdl%' OR LOWER(function_name) LIKE '%balldontlie%' OR
           LOWER(endpoint) LIKE '%bdl%' OR LOWER(endpoint) LIKE '%balldontlie%' OR
           LOWER(endpoint) LIKE '%injur%')
    GROUP BY function_name, endpoint
    ORDER BY hits DESC
  LOOP
    RAISE NOTICE '  function=% endpoint=% hits=%',
      v_row.function_name, v_row.endpoint, v_row.hits;
  END LOOP;
END $$;
