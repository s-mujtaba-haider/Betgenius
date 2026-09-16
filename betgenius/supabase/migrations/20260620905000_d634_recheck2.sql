DO $$ DECLARE r RECORD; BEGIN
  FOR r IN
    SELECT id, status_code, regexp_replace(LEFT(COALESCE(content::text,''),1500), E'[\\n\\r]+', ' ', 'g') AS body
      FROM net._http_response WHERE id = 31378
  LOOP RAISE NOTICE 'resp 31378 status=% body=%', r.status_code, r.body; END LOOP;
  FOR r IN
    SELECT count(*) AS n, count(DISTINCT bookmaker) AS books,
           count(DISTINCT event_id) AS games, count(DISTINCT market) AS markets,
           min(snapshot_time) AS first_snap, max(snapshot_time) AS last_snap,
           count(DISTINCT (event_id, market, player_name, pick_side, bookmaker)) AS distinct_picks
      FROM public.cache_odds_snapshots
     WHERE sport='mlb'
  LOOP
    RAISE NOTICE '[verify] rows=% books=% games=% markets=% distinct_picks=% first=% last=%',
      r.n, r.books, r.games, r.markets, r.distinct_picks, r.first_snap, r.last_snap;
  END LOOP;
END $$;
