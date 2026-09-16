-- Refactor notifications schema per CEO spec (May 6, 2026 evening).
--
-- Replaces notification_log (singular, shipped earlier same day in
-- migration 20260506000006) with notifications_log (plural). Two
-- substantive engineering improvements drive the rewrite:
--   1. INSERT-first then UPDATE pattern guarantees audit row exists
--      even if Twilio call hangs mid-flight (vs single-INSERT post-
--      decision which loses the audit if the helper crashes between).
--   2. Severity-specific rate limits (15min critical / 60min warning)
--      better match alert urgency vs uniform 15min.
--
-- Schema changes vs old table:
--   - twilio_status (5 enum values) → delivered_via ('sms'|'log'|'both')
--   - twilio_sid (TEXT) → twilio_response (JSONB, full Twilio response body)
--   - error_message → twilio_error
--   - sent_at → created_at (matches naming convention with other *_log tables)
--
-- Old table only contained 1 test row from my earlier same-day deployment;
-- dropping rather than migrating data.

DROP TABLE IF EXISTS public.notification_log CASCADE;

CREATE TABLE IF NOT EXISTS public.notifications_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  severity        TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  title           TEXT NOT NULL,
  message         TEXT NOT NULL,
  metadata        JSONB,
  delivered_via   TEXT CHECK (delivered_via IN ('sms', 'log', 'both')),
  twilio_response JSONB,
  twilio_error    TEXT
);

-- Recency index for CEO audit queries
CREATE INDEX IF NOT EXISTS idx_notifications_log_created
  ON public.notifications_log (created_at DESC);

-- Severity-filtered recency for "show me last 10 critical alerts" queries
CREATE INDEX IF NOT EXISTS idx_notifications_log_severity
  ON public.notifications_log (severity, created_at DESC);

-- Rate-limit lookup: notify() queries by (title, created_at) with a
-- severity-specific cutoff before sending. Compound index makes that
-- scan-free.
CREATE INDEX IF NOT EXISTS idx_notifications_log_title_created
  ON public.notifications_log (title, created_at DESC);

COMMENT ON TABLE public.notifications_log IS
  'Durable audit log for the notify() helper. Every alert produces a row '
  'regardless of whether SMS was sent (rate-limited, env-missing, severity-'
  'skipped, and Twilio-failed paths all log). delivered_via tracks final '
  'state: log=audit only / sms=SMS sent successfully / both=SMS sent AND '
  'audit row updated. INSERT-first pattern guarantees audit row exists even '
  'if Twilio call hangs mid-flight.';
