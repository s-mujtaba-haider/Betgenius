-- notification_log — durable record of every notify() invocation.
--
-- Three roles:
--   1. Rate-limiting state: notify() queries this table for "was this title
--      sent in last 15 min?" before calling Twilio. No in-memory state needed
--      across stateless edge function invocations.
--   2. Audit trail: every alert (sent, rate-limited, severity-skipped, failed,
--      env-missing) is recorded with full context. CEO can audit alert history.
--   3. Debug surface: when CEO complains "I didn't get an alert", we can prove
--      either (a) it sent and Twilio confirmed, (b) it was rate-limited, or
--      (c) Twilio failed with a specific error.

CREATE TABLE IF NOT EXISTS public.notification_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  title TEXT NOT NULL,
  message TEXT,
  metadata JSONB,
  twilio_sid TEXT,        -- Twilio SID when SMS sent successfully
  twilio_status TEXT NOT NULL CHECK (twilio_status IN (
    'sent',               -- delivered to Twilio successfully
    'rate_limited',       -- same title within 15 min — suppressed
    'severity_skip',      -- info-tier or warning outside waking hours
    'failed',             -- Twilio API call returned non-2xx
    'env_missing'         -- Twilio env vars not configured
  )),
  error_message TEXT      -- failure detail if twilio_status = 'failed'
);

-- Indexed for the rate-limit lookup: notify() queries by (title, sent_at)
-- with a 15-min cutoff. Compound index makes that scan-free.
CREATE INDEX IF NOT EXISTS idx_notification_log_title_sent
  ON public.notification_log (title, sent_at DESC);

-- For CEO audit / dashboard queries by recency
CREATE INDEX IF NOT EXISTS idx_notification_log_sent_at
  ON public.notification_log (sent_at DESC);

COMMENT ON TABLE public.notification_log IS
  'Durable audit log + rate-limit state for the notify() helper. Every alert '
  'invocation produces a row regardless of whether SMS was sent (rate-limited '
  'and severity-skipped paths also log). Indefinite retention.';
