-- D-302 SHIP 3 (2026-05-24) — dashboard_health_log + cron schedule.
--
-- Stores results of automated Dashboard health checks (per
-- /docs/loop/playbooks/dashboard_audit_methodology.md). Cron runs
-- every 2 hours during MLB game window; writes a row per check.
--
-- Rollback:
--   DROP TABLE IF EXISTS dashboard_health_log CASCADE;
--   SELECT cron.unschedule('dashboard-health-check-2h');

CREATE TABLE IF NOT EXISTS public.dashboard_health_log (
  id BIGSERIAL PRIMARY KEY,
  check_date DATE NOT NULL,
  verdict TEXT NOT NULL,           -- healthy | warning | degraded
  api_count INTEGER NOT NULL,
  cache_count INTEGER NOT NULL,
  gap_count INTEGER NOT NULL,
  gaps JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dashboard_health_log_check_date ON public.dashboard_health_log (check_date DESC);
CREATE INDEX IF NOT EXISTS idx_dashboard_health_log_verdict ON public.dashboard_health_log (verdict) WHERE verdict != 'healthy';

ALTER TABLE public.dashboard_health_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dashboard_health_log_service_all ON public.dashboard_health_log;
CREATE POLICY dashboard_health_log_service_all ON public.dashboard_health_log FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS dashboard_health_log_auth_read ON public.dashboard_health_log;
CREATE POLICY dashboard_health_log_auth_read ON public.dashboard_health_log FOR SELECT TO authenticated USING (true);

-- Schedule cron: every 2 hours during MLB game window (15:00 to 04:00 UTC).
DO $$
DECLARE
  v_anon_key TEXT;
  v_url TEXT;
BEGIN
  -- pg_cron requires invoking via HTTP; reuse the pattern used by other
  -- crons. The schedule fires every 2 hours within the MLB window so
  -- status changes (postponements, doubleheader transitions) get caught
  -- within 2 hours of MLB announcing them.
  PERFORM cron.unschedule('dashboard-health-check-2h') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='dashboard-health-check-2h');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'dashboard-health-check-2h',
  '15 15-23/2,1-3/2 * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_url', true) || '/functions/v1/dashboard-health-check',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.supabase_service_role_key', true),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

COMMENT ON TABLE public.dashboard_health_log IS
  'D-302 SHIP 3: automated MLB Dashboard health checks. Compares MLB Stats API truth to cache_mlb_game_scoreboard. Verdict: healthy | warning | degraded.';
