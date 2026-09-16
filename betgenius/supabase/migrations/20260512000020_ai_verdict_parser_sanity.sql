-- Read-only sanity probe for the §15.10 Critical #1 AI-verdict parser.
-- Confirms how many recent picks have TAKE/LEAN/FADE in the last ~160 chars
-- of ai_analysis (the parser's scan window). Used by the frontend parser as
-- a ground-truth sample to verify the regex isn't misfiring on prod prose.

DO $$
DECLARE
  r RECORD;
  take_count INT := 0;
  lean_count INT := 0;
  fade_count INT := 0;
  none_count INT := 0;
  total INT := 0;
BEGIN
  RAISE NOTICE '=== AI verdict trailing-token distribution (sample of 10) ===';
  FOR r IN
    SELECT
      LEFT(player_name, 18) AS player,
      confidence,
      RIGHT(ai_analysis, 80) AS tail,
      CASE
        -- Conservative bias: FADE > LEAN > TAKE if multiple in tail
        WHEN UPPER(RIGHT(ai_analysis, 160)) ~ '\mFADE\M' THEN 'FADE'
        WHEN UPPER(RIGHT(ai_analysis, 160)) ~ '\mLEAN\M' THEN 'LEAN'
        WHEN UPPER(RIGHT(ai_analysis, 160)) ~ '\mTAKE\M' THEN 'TAKE'
        ELSE 'null'
      END AS parsed_verdict
    FROM pick_history
    WHERE source = 'process-games'
      AND is_synthetic = false
      AND ai_analysis IS NOT NULL
      AND ai_analysis <> ''
      AND created_at >= NOW() - INTERVAL '36 hours'
    ORDER BY RANDOM()
    LIMIT 10
  LOOP
    RAISE NOTICE 'player=% conf=% verdict=% tail=...%',
      RPAD(r.player, 18), r.confidence, RPAD(r.parsed_verdict, 5), r.tail;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== Distribution across last 36h of organic picks ===';
  SELECT
    COUNT(*) FILTER (WHERE UPPER(RIGHT(ai_analysis, 160)) ~ '\mFADE\M'),
    COUNT(*) FILTER (WHERE UPPER(RIGHT(ai_analysis, 160)) ~ '\mLEAN\M'
                       AND UPPER(RIGHT(ai_analysis, 160)) !~ '\mFADE\M'),
    COUNT(*) FILTER (WHERE UPPER(RIGHT(ai_analysis, 160)) ~ '\mTAKE\M'
                       AND UPPER(RIGHT(ai_analysis, 160)) !~ '\mFADE\M'
                       AND UPPER(RIGHT(ai_analysis, 160)) !~ '\mLEAN\M'),
    COUNT(*) FILTER (WHERE UPPER(RIGHT(ai_analysis, 160)) !~ '\m(TAKE|LEAN|FADE)\M'),
    COUNT(*)
  INTO fade_count, lean_count, take_count, none_count, total
  FROM pick_history
  WHERE source = 'process-games' AND is_synthetic = false
    AND ai_analysis IS NOT NULL AND ai_analysis <> ''
    AND created_at >= NOW() - INTERVAL '36 hours';

  RAISE NOTICE 'total=% FADE=% LEAN=% TAKE=% null=%',
    total, fade_count, lean_count, take_count, none_count;

  IF total > 0 THEN
    RAISE NOTICE 'null_pct=%%% (must be <20%% to ship parser)',
      ROUND(100.0 * none_count / total, 1);
  END IF;
END $$;
