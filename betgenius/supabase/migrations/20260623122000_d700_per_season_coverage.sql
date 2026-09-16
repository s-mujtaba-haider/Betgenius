SET statement_timeout = '300s';

DROP TABLE IF EXISTS d700_coverage;
CREATE TABLE d700_coverage (section text, label text, n bigint, extra jsonb);

-- 1. boxscore_player_stats — pitchers (starters?) per season + with strikeouts populated
INSERT INTO d700_coverage(section,label,n,extra)
SELECT 'boxscore_pitchers_by_season',
       EXTRACT(YEAR FROM game_date)::text,
       count(*) FILTER (WHERE strikeouts IS NOT NULL AND innings_pitched > 0),
       jsonb_build_object('starters', count(*) FILTER (WHERE is_starter AND innings_pitched > 0))
FROM cache_mlb_boxscore_player_stats
GROUP BY 2 ORDER BY 2;

-- 2. cache_mlb_historical_arsenal — coverage per season (pitcher-seasons)
INSERT INTO d700_coverage(section,label,n)
SELECT 'arsenal_pitchers_by_season',
       season::text, count(*)
FROM cache_mlb_historical_arsenal
WHERE total_pitches > 0
GROUP BY 1,2 ORDER BY 2;

-- 3. cache_mlb_historical_pitcher_statcast coverage per season
INSERT INTO d700_coverage(section,label,n)
SELECT 'statcast_pitchers_by_season',
       season::text, count(*)
FROM cache_mlb_historical_pitcher_statcast
GROUP BY 1,2 ORDER BY 2;

-- 4. lineups coverage per season (need season via event_id → cache_mlb_historical_events)
INSERT INTO d700_coverage(section,label,n)
SELECT 'lineups_events',
       'distinct_event_id',
       count(DISTINCT event_id)
FROM cache_mlb_historical_lineups;

-- 5. weather per season (commence_time on table)
INSERT INTO d700_coverage(section,label,n)
SELECT 'weather_by_season',
       EXTRACT(YEAR FROM commence_time)::text, count(*)
FROM cache_mlb_historical_weather GROUP BY 2 ORDER BY 2;

-- 6. opposing_pitcher coverage
INSERT INTO d700_coverage(section,label,n)
SELECT 'opp_pitcher_events', 'distinct_event_id', count(DISTINCT event_id)
FROM cache_mlb_historical_opposing_pitcher;

-- 7. historical_outcomes per season (game-level)
INSERT INTO d700_coverage(section,label,n)
SELECT 'outcomes_by_season',
       EXTRACT(YEAR FROM commence_time)::text, count(*)
FROM cache_mlb_historical_outcomes WHERE game_completed=true
GROUP BY 2 ORDER BY 2;

-- 8. historical_replay_results — what's in it?
INSERT INTO d700_coverage(section,label,n)
SELECT 'replay_by_market', market_key, count(*)
FROM historical_replay_results
GROUP BY market_key ORDER BY count(*) DESC LIMIT 30;

INSERT INTO d700_coverage(section,label,n,extra)
SELECT 'replay_pk_by_year',
       EXTRACT(YEAR FROM snapshot_timestamp)::text,
       count(*),
       jsonb_build_object(
         'resolved', count(*) FILTER (WHERE hit IS NOT NULL),
         'unique_events', count(DISTINCT event_id),
         'unique_pitchers', count(DISTINCT player_name))
FROM historical_replay_results
WHERE market_key='pitcher_strikeouts'
GROUP BY 2 ORDER BY 2;

-- 9. pick_history pitcher_k by year — to confirm "943" provenance
INSERT INTO d700_coverage(section,label,n,extra)
SELECT 'pick_history_pk_by_year',
       EXTRACT(YEAR FROM created_at)::text,
       count(*),
       jsonb_build_object(
         'resolved', count(*) FILTER (WHERE hit IS NOT NULL),
         'unresolved', count(*) FILTER (WHERE hit IS NULL),
         'is_synth_true', count(*) FILTER (WHERE is_synthetic=true),
         'is_synth_false', count(*) FILTER (WHERE is_synthetic=false))
FROM pick_history
WHERE mlb_market_type='pitcher_k'
GROUP BY 2 ORDER BY 2;

-- 10. Sample row of historical_replay_results pitcher_k (1 row)
INSERT INTO d700_coverage(section,label,n,extra)
SELECT 'replay_pk_sample', player_name, 1,
       jsonb_build_object('market',market_key,'line',line,'side',algo_pick_side,
                          'confidence',algo_confidence,'hit',hit,
                          'actual_value',actual_value,'snapshot',snapshot_timestamp::text,
                          'breakdown_keys', (SELECT jsonb_agg(k) FROM (SELECT jsonb_object_keys(algo_breakdown) k LIMIT 30) s))
FROM historical_replay_results
WHERE market_key='pitcher_strikeouts'
LIMIT 1;

SELECT 'd700_per_season_coverage done: ' || count(*) AS done FROM d700_coverage;
