DO $$ DECLARE r RECORD; v_today text := to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYYMMDD'); BEGIN
  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-618 — props_cache last_seen movement diagnosis';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  RAISE NOTICE '[O] props_cache today — first_seen vs last_seen distribution:';
  FOR r IN
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE last_seen > first_seen) AS rows_re_seen,
      count(*) FILTER (WHERE last_seen = first_seen) AS rows_only_once,
      max(last_seen) AS latest_seen,
      max(first_seen) AS latest_first_seen,
      min(first_seen) AS earliest_first_seen
    FROM public.props_cache
    WHERE sport='mlb' AND game_date = v_today
  LOOP
    RAISE NOTICE '  total=% re_seen=% only_once=% latest_seen=% latest_first=% earliest_first=%',
      r.total, r.rows_re_seen, r.rows_only_once, r.latest_seen, r.latest_first_seen, r.earliest_first_seen;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '[P] re-seen rows (last_seen >> first_seen) histogram by gap:';
  FOR r IN
    SELECT
      width_bucket(EXTRACT(EPOCH FROM (last_seen - first_seen)) / 60.0, 0, 360, 12) AS bucket_min,
      count(*) AS rows,
      min(EXTRACT(EPOCH FROM (last_seen - first_seen)) / 60.0)::numeric(10,2) AS min_gap_min,
      max(EXTRACT(EPOCH FROM (last_seen - first_seen)) / 60.0)::numeric(10,2) AS max_gap_min
    FROM public.props_cache
    WHERE sport='mlb' AND game_date = v_today
      AND last_seen > first_seen
    GROUP BY width_bucket(EXTRACT(EPOCH FROM (last_seen - first_seen)) / 60.0, 0, 360, 12)
    ORDER BY width_bucket(EXTRACT(EPOCH FROM (last_seen - first_seen)) / 60.0, 0, 360, 12)
  LOOP
    RAISE NOTICE '  bucket=% rows=% gap_min=% gap_max=%', r.bucket_min, r.rows, r.min_gap_min, r.max_gap_min;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '[Q] re-seen rows in last 1 hour (where last_seen >= now-1h):';
  FOR r IN
    SELECT
      count(*) AS rows_touched_last_hour,
      count(DISTINCT (player_name, prop_type, line, pick_side, bookmaker)) AS distinct_tuples
    FROM public.props_cache
    WHERE sport='mlb' AND game_date = v_today
      AND last_seen >= now() - interval '1 hour'
  LOOP
    RAISE NOTICE '  rows_touched_last_hour=% distinct_tuples=%', r.rows_touched_last_hour, r.distinct_tuples;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '[R] sample 8 rows MOST RECENTLY last_seen (game_date=today):';
  FOR r IN
    SELECT player_name, prop_type, line, pick_side, bookmaker, odds, first_seen, last_seen
      FROM public.props_cache
     WHERE sport='mlb' AND game_date = v_today
     ORDER BY last_seen DESC LIMIT 8
  LOOP
    RAISE NOTICE '  %|%|line=% pick=% book=% odds=% first=% last=%',
      r.player_name, r.prop_type, r.line, r.pick_side, r.bookmaker, r.odds, r.first_seen, r.last_seen;
  END LOOP;
END $$;
