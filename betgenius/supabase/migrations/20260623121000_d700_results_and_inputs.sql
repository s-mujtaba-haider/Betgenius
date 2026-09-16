SET statement_timeout = '300s';

DROP TABLE IF EXISTS d700_tablespec;
CREATE TABLE d700_tablespec (
    tbl text, col text, dtype text, ord int
);

INSERT INTO d700_tablespec(tbl,col,dtype,ord)
SELECT table_name, column_name, data_type, ordinal_position
FROM information_schema.columns
WHERE table_schema='public'
  AND table_name IN ('cache_mlb_historical_outcomes',
                     'cache_mlb_boxscore_player_stats',
                     'cache_mlb_historical_pitcher_statcast',
                     'cache_mlb_historical_arsenal',
                     'cache_mlb_historical_lineups',
                     'cache_mlb_historical_opposing_pitcher',
                     'cache_mlb_historical_splits',
                     'cache_mlb_historical_framing',
                     'cache_pitcher_game_logs',
                     'cache_mlb_historical_weather',
                     'historical_replay_results',
                     'pick_history_real')
ORDER BY table_name, ordinal_position;

DROP TABLE IF EXISTS d700_table_counts;
CREATE TABLE d700_table_counts (tbl text, label text, n bigint);

-- These are cache tables; counts can be slow on big ones but tractable with idx on commence_time/season
-- Try cheap counts first; skip the very large ones if they have no commence_time index

-- historical_outcomes — likely the K results
INSERT INTO d700_table_counts(tbl,label,n)
SELECT 'cache_mlb_historical_outcomes','total',count(*) FROM cache_mlb_historical_outcomes;

INSERT INTO d700_table_counts(tbl,label,n)
SELECT 'cache_mlb_boxscore_player_stats','total',count(*) FROM cache_mlb_boxscore_player_stats;

INSERT INTO d700_table_counts(tbl,label,n)
SELECT 'cache_pitcher_game_logs','total',count(*) FROM cache_pitcher_game_logs;

INSERT INTO d700_table_counts(tbl,label,n)
SELECT 'cache_mlb_historical_pitcher_statcast','total',count(*) FROM cache_mlb_historical_pitcher_statcast;

INSERT INTO d700_table_counts(tbl,label,n)
SELECT 'cache_mlb_historical_arsenal','total',count(*) FROM cache_mlb_historical_arsenal;

INSERT INTO d700_table_counts(tbl,label,n)
SELECT 'cache_mlb_historical_lineups','total',count(*) FROM cache_mlb_historical_lineups;

INSERT INTO d700_table_counts(tbl,label,n)
SELECT 'cache_mlb_historical_opposing_pitcher','total',count(*) FROM cache_mlb_historical_opposing_pitcher;

INSERT INTO d700_table_counts(tbl,label,n)
SELECT 'cache_mlb_historical_splits','total',count(*) FROM cache_mlb_historical_splits;

INSERT INTO d700_table_counts(tbl,label,n)
SELECT 'cache_mlb_historical_framing','total',count(*) FROM cache_mlb_historical_framing;

INSERT INTO d700_table_counts(tbl,label,n)
SELECT 'cache_mlb_historical_weather','total',count(*) FROM cache_mlb_historical_weather;

INSERT INTO d700_table_counts(tbl,label,n)
SELECT 'historical_replay_results','total',count(*) FROM historical_replay_results;

INSERT INTO d700_table_counts(tbl,label,n)
SELECT 'pick_history_real','total',count(*) FROM pick_history_real;

SELECT 'd700_results_and_inputs done' AS done;
