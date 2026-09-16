DO $$
DECLARE v_pending BIGINT; v_resolved_total BIGINT;
        v_rate NUMERIC; v_eta NUMERIC; v_elapsed_min NUMERIC;
BEGIN
  SELECT count(*) INTO v_pending FROM public.pick_history
   WHERE hit IS NULL AND resolved_at IS NULL AND voided <> true
     AND is_synthetic = false AND game_date >= DATE '2026-05-28';
  SELECT count(*) INTO v_resolved_total FROM public.pick_history
   WHERE resolved_at >= '2026-06-11 02:11:00+00';

  v_elapsed_min := EXTRACT(EPOCH FROM (NOW() - '2026-06-11 02:11:00+00'::TIMESTAMPTZ)) / 60.0;
  v_rate := CASE WHEN v_elapsed_min > 0 THEN v_resolved_total / v_elapsed_min ELSE 0 END;
  v_eta  := CASE WHEN v_rate > 0 THEN v_pending / v_rate ELSE NULL END;

  RAISE NOTICE '[D-506 progress] pending=% resolved=% elapsed_min=% rate=%/min ETA_min=%',
    v_pending, v_resolved_total,
    ROUND(v_elapsed_min, 1),
    ROUND(v_rate, 1),
    COALESCE(ROUND(v_eta, 1)::text, 'n/a');
END $$;
