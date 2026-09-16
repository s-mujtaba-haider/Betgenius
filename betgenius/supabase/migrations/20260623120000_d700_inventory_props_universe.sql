SET statement_timeout = '300s';

DROP TABLE IF EXISTS d700_inventory;
CREATE TABLE d700_inventory (
    section text, label text, n bigint, extra jsonb
);

-- 1. pitcher_strikeouts count (simple, indexed if market_key has index)
INSERT INTO d700_inventory(section,label,n)
SELECT 'totals','pitcher_strikeouts',count(*)
FROM cache_mlb_historical_odds WHERE market_key='pitcher_strikeouts';

-- 2. Per-year row count (no DISTINCT — much cheaper)
INSERT INTO d700_inventory(section,label,n)
SELECT 'pk_rows_per_year', EXTRACT(YEAR FROM commence_time)::text, count(*)
FROM cache_mlb_historical_odds WHERE market_key='pitcher_strikeouts'
GROUP BY 2 ORDER BY 2;

-- 3. Tables that might hold results — schema-level lookup is cheap
INSERT INTO d700_inventory(section,label,n)
SELECT 'tables', table_name, NULL
FROM information_schema.tables
WHERE table_schema='public'
  AND (table_name ILIKE '%pitcher%' OR table_name ILIKE '%box%'
       OR table_name ILIKE '%game_log%' OR table_name ILIKE '%result%'
       OR table_name ILIKE '%cache_mlb%' OR table_name ILIKE '%pick_history%'
       OR table_name ILIKE '%stat%')
ORDER BY 2;

SELECT 'd700_inventory rows: ' || count(*) AS done FROM d700_inventory;
