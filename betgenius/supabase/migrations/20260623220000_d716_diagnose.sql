SET statement_timeout = '60s';
DO $$ DECLARE rec record; total int; stuck int;
BEGIN
  RAISE NOTICE '=== State breakdown of 14+d non-synth MLB hit=null ===';
  FOR rec IN
    SELECT
      CASE WHEN actual_value IS NULL THEN 'actual_null' ELSE 'actual_populated' END AS av_state,
      CASE WHEN voided IS TRUE THEN 'voided' ELSE 'not_voided' END AS vstate,
      count(*) AS n
    FROM pick_history
    WHERE hit IS NULL AND created_at <= NOW() - INTERVAL '14 days'
      AND is_synthetic = false AND sport = 'mlb'
    GROUP BY 1,2 ORDER BY 3 DESC
  LOOP
    RAISE NOTICE '  av=% v=% n=%', rec.av_state, rec.vstate, rec.n;
  END LOOP;

  RAISE NOTICE '=== Same breakdown with resolved_at vs null ===';
  FOR rec IN
    SELECT
      CASE WHEN resolved_at IS NULL THEN 'never_resolved' ELSE 'resolved_at_set' END AS r_state,
      CASE WHEN actual_value IS NULL THEN 'actual_null' ELSE 'actual_populated' END AS av_state,
      CASE WHEN voided IS TRUE THEN 'voided' ELSE 'not_voided' END AS vstate,
      count(*) AS n
    FROM pick_history
    WHERE hit IS NULL AND created_at <= NOW() - INTERVAL '14 days'
      AND is_synthetic = false AND sport = 'mlb'
    GROUP BY 1,2,3 ORDER BY 4 DESC
  LOOP
    RAISE NOTICE '  r=% av=% v=% n=%', rec.r_state, rec.av_state, rec.vstate, rec.n;
  END LOOP;

  -- Of the box-score-available subset, how many have actual_value null (truly stuck)?
  RAISE NOTICE '=== Box score match + state ===';
  SELECT count(*) INTO total FROM pick_history p
    WHERE p.hit IS NULL AND p.created_at <= NOW() - INTERVAL '14 days'
      AND p.is_synthetic = false AND p.sport = 'mlb'
      AND p.actual_value IS NULL AND COALESCE(p.voided,false) = false
      AND EXISTS (SELECT 1 FROM cache_mlb_boxscore_player_stats b
                  WHERE b.player_name = p.player_name AND b.game_date = p.game_date);
  RAISE NOTICE 'Truly-stuck-recoverable subset (actual=null, voided=false, box-match): %', total;

  -- And how many never-resolved (resolved_at null too)?
  SELECT count(*) INTO total FROM pick_history p
    WHERE p.hit IS NULL AND p.created_at <= NOW() - INTERVAL '14 days'
      AND p.is_synthetic = false AND p.sport = 'mlb'
      AND p.actual_value IS NULL AND COALESCE(p.voided,false) = false
      AND p.resolved_at IS NULL
      AND EXISTS (SELECT 1 FROM cache_mlb_boxscore_player_stats b
                  WHERE b.player_name = p.player_name AND b.game_date = p.game_date);
  RAISE NOTICE '  ...of which never_resolved (d692 drain target): %', total;
  SELECT count(*) INTO total FROM pick_history p
    WHERE p.hit IS NULL AND p.created_at <= NOW() - INTERVAL '14 days'
      AND p.is_synthetic = false AND p.sport = 'mlb'
      AND p.actual_value IS NULL AND COALESCE(p.voided,false) = false
      AND p.resolved_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM cache_mlb_boxscore_player_stats b
                  WHERE b.player_name = p.player_name AND b.game_date = p.game_date);
  RAISE NOTICE '  ...of which resolved_at_set (recovery needed): %', total;
END $$;
