SET statement_timeout = '120s';
DO $$ DECLARE rec record; box_match int;
BEGIN
  RAISE NOTICE '=== 20 non-synthetic ancient MLB picks (most recent first) ===';
  FOR rec IN
    SELECT id, game_date, mlb_market_type AS market,
           player_name, source, line, pick_side, odds,
           resolved_at::date AS rdate, resolution_note
    FROM pick_history
    WHERE hit IS NULL AND created_at <= NOW() - INTERVAL '14 days'
      AND is_synthetic = false AND sport='mlb'
    ORDER BY created_at DESC LIMIT 20
  LOOP
    SELECT count(*) INTO box_match
    FROM cache_mlb_boxscore_player_stats
    WHERE player_name = rec.player_name AND game_date = rec.game_date;
    RAISE NOTICE 'mlb_pick=% game=% market=% line=% side=% odds=% src=% resolved=% box=% note=%',
      substring(rec.id::text,1,8), rec.game_date, rec.market, rec.line, rec.pick_side, rec.odds, rec.source,
      COALESCE(rec.rdate::text,'never'), box_match, COALESCE(rec.resolution_note,'(none)');
  END LOOP;

  RAISE NOTICE '=== 20 non-synthetic ancient NBA picks ===';
  FOR rec IN
    SELECT id, game_date, prop_type AS market, player_name, source, line, pick_side, odds,
           resolved_at::date AS rdate, resolution_note
    FROM pick_history
    WHERE hit IS NULL AND created_at <= NOW() - INTERVAL '14 days'
      AND is_synthetic = false AND sport='nba'
    ORDER BY created_at DESC LIMIT 20
  LOOP
    RAISE NOTICE 'nba_pick=% game=% market=% line=% side=% odds=% src=% resolved=% note=%',
      substring(rec.id::text,1,8), rec.game_date, rec.market, rec.line, rec.pick_side, rec.odds, rec.source,
      COALESCE(rec.rdate::text,'never'), COALESCE(rec.resolution_note,'(none)');
  END LOOP;
END $$;
