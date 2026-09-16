-- D-505 SHIP 1 v4 — game_date IS date type. READ-ONLY.
DO $$
DECLARE
  v_n_pre BIGINT; v_w_pre BIGINT; v_roi_pre NUMERIC;
  v_n_post BIGINT; v_w_post BIGINT; v_roi_post NUMERIC;
  v_n_high_pre BIGINT; v_n_high_post BIGINT;
  v_n_low_pre BIGINT; v_n_low_post BIGINT;
  v_split DATE := DATE '2026-06-08';
  r RECORD;
BEGIN
  -- BEFORE
  SELECT count(*),
         count(*) FILTER (WHERE hit),
         sum(CASE WHEN hit THEN
               CASE WHEN odds > 0 THEN odds::numeric/100.0 ELSE 100.0/abs(odds::numeric) END
             ELSE -1.0 END)
    INTO v_n_pre, v_w_pre, v_roi_pre
   FROM public.pick_history_real
   WHERE confidence BETWEEN 65 AND 79
     AND pick_side='over' AND odds >= 100
     AND game_date < v_split AND is_synthetic = false;

  -- AFTER
  SELECT count(*),
         count(*) FILTER (WHERE hit),
         sum(CASE WHEN hit THEN
               CASE WHEN odds > 0 THEN odds::numeric/100.0 ELSE 100.0/abs(odds::numeric) END
             ELSE -1.0 END)
    INTO v_n_post, v_w_post, v_roi_post
   FROM public.pick_history_real
   WHERE confidence BETWEEN 65 AND 79
     AND pick_side='over' AND odds >= 100
     AND game_date >= v_split AND is_synthetic = false;

  -- Cap mechanic: high-conf 70-79
  SELECT count(*) INTO v_n_high_pre FROM public.pick_history_real
   WHERE confidence BETWEEN 70 AND 79 AND pick_side='over' AND odds >= 100
     AND game_date < v_split AND is_synthetic = false;
  SELECT count(*) INTO v_n_high_post FROM public.pick_history_real
   WHERE confidence BETWEEN 70 AND 79 AND pick_side='over' AND odds >= 100
     AND game_date >= v_split AND is_synthetic = false;

  -- 65-69 absorber
  SELECT count(*) INTO v_n_low_pre FROM public.pick_history_real
   WHERE confidence BETWEEN 65 AND 69 AND pick_side='over' AND odds >= 100
     AND game_date < v_split AND is_synthetic = false;
  SELECT count(*) INTO v_n_low_post FROM public.pick_history_real
   WHERE confidence BETWEEN 65 AND 69 AND pick_side='over' AND odds >= 100
     AND game_date >= v_split AND is_synthetic = false;

  RAISE NOTICE '[D-505 D-479] BEFORE n=% wins=% WR=%pct ROI/$1stake=%u',
    v_n_pre, v_w_pre,
    ROUND(CASE WHEN v_n_pre>0 THEN v_w_pre*100.0/v_n_pre ELSE 0 END, 2),
    ROUND(COALESCE(v_roi_pre,0), 2);
  RAISE NOTICE '[D-505 D-479] AFTER  n=% wins=% WR=%pct ROI/$1stake=%u',
    v_n_post, v_w_post,
    ROUND(CASE WHEN v_n_post>0 THEN v_w_post*100.0/v_n_post ELSE 0 END, 2),
    ROUND(COALESCE(v_roi_post,0), 2);
  RAISE NOTICE '[D-505 D-479] cap mechanic high-conf 70-79: BEFORE=% AFTER=% (target near-0)',
    v_n_high_pre, v_n_high_post;
  RAISE NOTICE '[D-505 D-479] cap mechanic low-conf 65-69: BEFORE=% AFTER=% (absorber)',
    v_n_low_pre, v_n_low_post;

  -- By sport AFTER
  RAISE NOTICE '[D-505 D-479] AFTER by sport:';
  FOR r IN
    SELECT sport, count(*) AS n,
           count(*) FILTER (WHERE hit) AS wins,
           ROUND(count(*) FILTER (WHERE hit) * 100.0 / NULLIF(count(*),0), 2) AS wr_pct
    FROM public.pick_history_real
    WHERE confidence BETWEEN 65 AND 79
      AND pick_side='over' AND odds >= 100
      AND game_date >= v_split AND is_synthetic = false
    GROUP BY sport ORDER BY n DESC
  LOOP
    RAISE NOTICE '  sport=% n=% wins=% WR=%pct', r.sport, r.n, r.wins, r.wr_pct;
  END LOOP;

  -- Also show date range of post-cutover data
  RAISE NOTICE '[D-505 D-479] date span of AFTER cohort:';
  FOR r IN
    SELECT min(game_date) AS first_date, max(game_date) AS last_date,
           count(DISTINCT game_date) AS distinct_dates
    FROM public.pick_history_real
    WHERE pick_side='over' AND odds >= 100
      AND game_date >= v_split AND is_synthetic = false
  LOOP
    RAISE NOTICE '  first=% last=% distinct_dates=%', r.first_date, r.last_date, r.distinct_dates;
  END LOOP;
END $$;
