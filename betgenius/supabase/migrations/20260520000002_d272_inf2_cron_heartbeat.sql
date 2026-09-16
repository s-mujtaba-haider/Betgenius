-- D-272-INF-2 (2026-05-20) — cron_heartbeat table + maintenance trigger.
--
-- Each cron writes a row at the end of its handler (success path AND
-- error path). The row is upserted on (job_name) so the table grows
-- to N rows where N = number of distinct crons (~12-15 expected).
--
-- detect_silent_crons() — companion VIEW that returns rows where
-- the heartbeat hasn't fired within 2× the expected interval.
--
-- RLS: service_role full access (edge functions write here). All other
-- roles get SELECT only — Dashboard / admin view should be able to
-- read state without elevated privileges.
--
-- Rollback:
--   DROP TABLE public.cron_heartbeat CASCADE;

CREATE TABLE IF NOT EXISTS public.cron_heartbeat (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name                   text NOT NULL,
  last_fired_at              timestamptz NOT NULL DEFAULT now(),
  last_status                text NOT NULL CHECK (last_status IN ('success','error','partial')),
  last_duration_ms           integer,
  last_error                 text,
  consecutive_failures       integer NOT NULL DEFAULT 0,
  expected_interval_seconds  integer,
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS cron_heartbeat_job_name_idx
  ON public.cron_heartbeat(job_name);

CREATE INDEX IF NOT EXISTS cron_heartbeat_fired_at_idx
  ON public.cron_heartbeat(last_fired_at DESC);

-- Maintenance trigger: bump updated_at on any row touch.
CREATE OR REPLACE FUNCTION public.cron_heartbeat_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cron_heartbeat_updated_at ON public.cron_heartbeat;
CREATE TRIGGER cron_heartbeat_updated_at
  BEFORE UPDATE ON public.cron_heartbeat
  FOR EACH ROW
  EXECUTE FUNCTION public.cron_heartbeat_touch_updated_at();

-- RLS
ALTER TABLE public.cron_heartbeat ENABLE ROW LEVEL SECURITY;

-- Authenticated + anon read-only — Dashboard observability tile may
-- consume this without an admin role. No writes outside service_role.
DROP POLICY IF EXISTS cron_heartbeat_authed_read ON public.cron_heartbeat;
CREATE POLICY cron_heartbeat_authed_read ON public.cron_heartbeat
  FOR SELECT TO authenticated, anon
  USING (true);

DROP POLICY IF EXISTS cron_heartbeat_service_all ON public.cron_heartbeat;
CREATE POLICY cron_heartbeat_service_all ON public.cron_heartbeat
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

GRANT SELECT ON public.cron_heartbeat TO anon, authenticated;
GRANT ALL    ON public.cron_heartbeat TO service_role;

COMMENT ON TABLE public.cron_heartbeat IS
  'D-272-INF-2: per-cron liveness signal. Edge function writes one '
  'row per cron with status + duration + last_error on every '
  'invocation. Companion view detect_silent_crons surfaces rows '
  'that have aged past 2× their expected_interval_seconds.';

-- Companion view: silent crons = no heartbeat within 2× expected interval.
DROP VIEW IF EXISTS public.detect_silent_crons;
CREATE VIEW public.detect_silent_crons AS
SELECT
  h.job_name,
  h.last_fired_at,
  h.last_status,
  h.consecutive_failures,
  h.expected_interval_seconds,
  EXTRACT(EPOCH FROM (now() - h.last_fired_at))::integer AS seconds_since_last_fire,
  CASE
    WHEN h.expected_interval_seconds IS NULL THEN false
    WHEN EXTRACT(EPOCH FROM (now() - h.last_fired_at)) > (h.expected_interval_seconds * 2) THEN true
    ELSE false
  END AS is_silent
FROM public.cron_heartbeat h;

GRANT SELECT ON public.detect_silent_crons TO anon, authenticated, service_role;

COMMENT ON VIEW public.detect_silent_crons IS
  'D-272-INF-2: derived liveness signal — is_silent=true when a cron '
  'has not heartbeated within 2× its expected_interval_seconds.';

-- Seed expected intervals for the 5 highest-traffic crons (matches
-- known cron schedules in pg_cron.job). expected_interval_seconds is
-- nullable so future crons that opt-in just write a heartbeat.
INSERT INTO public.cron_heartbeat (job_name, last_status, last_fired_at, expected_interval_seconds)
VALUES
  ('process-games-mlb', 'success', '1970-01-01T00:00:00Z', 1800),
  ('process-games',     'success', '1970-01-01T00:00:00Z', 1800),
  ('resolve-picks',     'success', '1970-01-01T00:00:00Z', 1800),
  ('fetch-odds',        'success', '1970-01-01T00:00:00Z', 1800),
  ('fetch-odds-mlb',    'success', '1970-01-01T00:00:00Z', 1800)
ON CONFLICT (job_name) DO NOTHING;
