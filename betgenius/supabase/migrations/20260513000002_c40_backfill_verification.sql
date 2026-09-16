-- C40 organic backfill verification, May 10-12 window. Read-only.
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '=== TASK 1: volume by day ===';
  RAISE NOTICE 'game_day   |  total | synth | organic | unres | voided';
  FOR r IN
    SELECT
      game_date::TEXT AS game_day,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE is_synthetic = true) AS synthetic,
      COUNT(*) FILTER (WHERE is_synthetic = false) AS organic,
      COUNT(*) FILTER (WHERE hit IS NULL) AS unresolved,
      COUNT(*) FILTER (WHERE voided = true) AS voided
    FROM pick_history
    WHERE game_date BETWEEN '2026-05-10' AND '2026-05-12'
    GROUP BY game_date ORDER BY game_date
  LOOP
    RAISE NOTICE '% | % | % | % | % | %',
      RPAD(r.game_day, 10), LPAD(r.total::TEXT, 6),
      LPAD(r.synthetic::TEXT, 5), LPAD(r.organic::TEXT, 7),
      LPAD(r.unresolved::TEXT, 5), LPAD(r.voided::TEXT, 6);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== TASK 2: source distribution (organic only) ===';
  FOR r IN
    SELECT source, COUNT(*) AS n
    FROM pick_history
    WHERE game_date BETWEEN '2026-05-10' AND '2026-05-12'
      AND is_synthetic = false
    GROUP BY source ORDER BY n DESC
  LOOP
    RAISE NOTICE 'source=% n=%', RPAD(r.source, 20), r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== TASK 3: resolution health May 10-11 (fully resolved expected) ===';
  FOR r IN
    SELECT
      COUNT(*) FILTER (WHERE hit IS NULL) AS unresolved,
      COUNT(*) FILTER (WHERE hit IS TRUE) AS wins,
      COUNT(*) FILTER (WHERE hit IS FALSE) AS losses,
      COUNT(*) FILTER (WHERE voided = TRUE) AS voided,
      COUNT(*) AS total
    FROM pick_history
    WHERE game_date BETWEEN '2026-05-10' AND '2026-05-11'
      AND is_synthetic = false AND source = 'process-games'
  LOOP
    RAISE NOTICE 'May 10-11 organic process-games: unres=% wins=% losses=% voided=% total=%',
      r.unresolved, r.wins, r.losses, r.voided, r.total;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== TASK 3b: May 12 resolution (partial expected) ===';
  FOR r IN
    SELECT
      COUNT(*) FILTER (WHERE hit IS NULL) AS unresolved,
      COUNT(*) FILTER (WHERE hit IS TRUE) AS wins,
      COUNT(*) FILTER (WHERE hit IS FALSE) AS losses,
      COUNT(*) FILTER (WHERE voided = TRUE) AS voided,
      COUNT(*) AS total
    FROM pick_history
    WHERE game_date = '2026-05-12'
      AND is_synthetic = false AND source = 'process-games'
  LOOP
    RAISE NOTICE 'May 12 organic process-games: unres=% wins=% losses=% voided=% total=%',
      r.unresolved, r.wins, r.losses, r.voided, r.total;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== TASK 4: confidence distribution May 10-12 organic process-games ===';
  FOR r IN
    SELECT
      CASE WHEN confidence < 60 THEN '<60'
           WHEN confidence < 70 THEN '60-69'
           WHEN confidence < 80 THEN '70-79'
           WHEN confidence < 90 THEN '80-89'
           ELSE '90+' END AS tier,
      COUNT(*) AS n,
      CASE WHEN confidence < 60 THEN 1 WHEN confidence < 70 THEN 2
           WHEN confidence < 80 THEN 3 WHEN confidence < 90 THEN 4 ELSE 5 END AS sk
    FROM pick_history
    WHERE game_date BETWEEN '2026-05-10' AND '2026-05-12'
      AND is_synthetic = false AND source = 'process-games'
    GROUP BY 1, sk ORDER BY sk
  LOOP
    RAISE NOTICE 'tier=% n=%', RPAD(r.tier, 6), r.n;
  END LOOP;
END $$;
