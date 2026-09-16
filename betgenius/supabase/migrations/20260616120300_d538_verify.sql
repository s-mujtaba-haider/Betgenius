-- D-538 — post-deploy verification scaffold.
-- This query lets the next batch (or sonnet-health-monitor) confirm that
-- after the deploy, ZERO disagree-with-projection picks land in pick_history.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '30s';

  -- §A — count disagree picks per day, last 7 days. After the deploy
  -- (today's process-games-mlb tick onward), the count for new dates
  -- should be 0.
  RAISE NOTICE '======== D-538 §A: disagree-with-projection picks by date (last 7d) ========';
  FOR r IN
    SELECT
      game_date,
      count(*) AS total_picks,
      count(*) FILTER (WHERE
        (pick_side = 'over' AND projected_stat < line)
        OR (pick_side = 'under' AND projected_stat > line)
      ) AS disagree_count,
      ROUND(100.0 * count(*) FILTER (WHERE
        (pick_side = 'over' AND projected_stat < line)
        OR (pick_side = 'under' AND projected_stat > line)
      ) / NULLIF(count(*),0), 1) AS disagree_pct
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND game_date >= current_date - interval '7 days'
      AND projected_stat IS NOT NULL
      AND pick_side IN ('over','under')
    GROUP BY game_date ORDER BY game_date DESC
  LOOP RAISE NOTICE '[D-538 §A.1] game_date=% total=% disagree=% pct=%',
    r.game_date, r.total_picks, r.disagree_count, r.disagree_pct; END LOOP;

  -- §B — the verify-success criterion: zero NEW disagree picks
  -- written today (game_date today) post-deploy. If today's cron has
  -- already run, this should be 0; if not yet, this just shows the
  -- pre-deploy baseline.
  FOR r IN
    SELECT
      count(*) AS today_total,
      count(*) FILTER (WHERE
        (pick_side = 'over' AND projected_stat < line)
        OR (pick_side = 'under' AND projected_stat > line)
      ) AS today_disagree
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND game_date = current_date
      AND projected_stat IS NOT NULL
      AND pick_side IN ('over','under')
  LOOP RAISE NOTICE '[D-538 §B.1] today (game_date=%) total=% disagree=%',
    current_date, r.today_total, r.today_disagree; END LOOP;

  -- §C — error_log: look for the d538_gate_rejections summaries from
  -- recent process-games-mlb runs.
  RAISE NOTICE '======== D-538 §C: gate rejection summaries from error_log ========';
  FOR r IN
    SELECT created_at, error_type, LEFT(error_message, 200) AS msg,
           (context->>'total_rejected') AS total_rejected,
           context->'by_market' AS by_market
    FROM public.error_log
    WHERE function_name='process-games-mlb'
      AND error_type='d538_gate_rejections'
      AND created_at > now() - interval '4 hours'
    ORDER BY created_at DESC LIMIT 10
  LOOP RAISE NOTICE '[D-538 §C.1] % rejected=% by_mkt=%',
    r.created_at, r.total_rejected, r.by_market; END LOOP;
END $$;
