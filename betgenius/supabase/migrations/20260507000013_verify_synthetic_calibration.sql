-- Calibration sanity check for synthetic corpus (May 7, 2026 evening Item 4.4).
-- Read-only NOTICE output. Confirms tier hit rates match expected post-cleanup
-- values: 90+ ~71.8%, 80-89 ~62.4%, 70-79 ~57.7%, 60-69 ~56.5%, <60 ~52.9%.

DO $$
DECLARE
  v_row RECORD;
BEGIN
  RAISE NOTICE '[calib] tier | picks | wins | hit_rate%%';
  FOR v_row IN
    SELECT tier, picks, wins, hit_rate_pct FROM (
      SELECT
        CASE WHEN confidence >= 90 THEN '90+'
             WHEN confidence >= 80 THEN '80-89'
             WHEN confidence >= 70 THEN '70-79'
             WHEN confidence >= 60 THEN '60-69'
             ELSE '<60' END AS tier,
        COUNT(*) AS picks,
        SUM(CASE WHEN hit THEN 1 ELSE 0 END) AS wins,
        ROUND(100.0 * SUM(CASE WHEN hit THEN 1 ELSE 0 END)::NUMERIC /
          NULLIF(COUNT(*) FILTER (WHERE hit IS NOT NULL), 0), 1) AS hit_rate_pct
      FROM pick_history
      WHERE is_synthetic = true
        AND hit IS NOT NULL
      GROUP BY 1
    ) sub
    ORDER BY
      CASE tier WHEN '90+' THEN 1 WHEN '80-89' THEN 2 WHEN '70-79' THEN 3
                WHEN '60-69' THEN 4 ELSE 5 END
  LOOP
    RAISE NOTICE '[calib] % | % | % | %', v_row.tier, v_row.picks, v_row.wins, v_row.hit_rate_pct;
  END LOOP;
END $$;
