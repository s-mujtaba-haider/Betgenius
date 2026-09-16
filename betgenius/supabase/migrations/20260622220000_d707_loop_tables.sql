-- D-707 — Loop infrastructure tables. Shadow-only; no production-scoring impact.

-- Run log: every (iteration, task) writes one row. CEO reads this in the morning.
CREATE TABLE IF NOT EXISTS public.loop_run_log (
  id                BIGSERIAL PRIMARY KEY,
  iteration_id      TEXT NOT NULL,
  task_id           TEXT NOT NULL,
  task_spec         JSONB NOT NULL,
  builder_result    JSONB,
  evaluator_verdict TEXT CHECK (evaluator_verdict IN ('PASS', 'FAIL', 'PENDING', 'SKIPPED')),
  evaluator_reason  TEXT,
  evaluator_evidence JSONB,
  db_health_at_start JSONB,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS loop_run_log_started_idx ON public.loop_run_log (started_at DESC);
CREATE INDEX IF NOT EXISTS loop_run_log_verdict_idx ON public.loop_run_log (evaluator_verdict, started_at DESC);

-- Kill switch: single-row table. Set stop=true to halt the loop.
CREATE TABLE IF NOT EXISTS public.loop_kill_switch (
  id            INT PRIMARY KEY DEFAULT 1,
  stop          BOOLEAN NOT NULL DEFAULT false,
  reason        TEXT,
  set_at        TIMESTAMPTZ,
  CONSTRAINT loop_kill_switch_single_row CHECK (id = 1)
);

-- Seed the single row if absent
INSERT INTO public.loop_kill_switch(id, stop, reason)
VALUES (1, false, 'init')
ON CONFLICT (id) DO NOTHING;

-- Helper view for CEO morning read
CREATE OR REPLACE VIEW public.loop_run_log_recent AS
SELECT
  iteration_id,
  task_id,
  evaluator_verdict,
  evaluator_reason,
  started_at,
  completed_at,
  EXTRACT(EPOCH FROM (completed_at - started_at)) AS duration_seconds,
  (task_spec ->> 'goal') AS task_goal
FROM public.loop_run_log
WHERE started_at > NOW() - INTERVAL '7 days'
ORDER BY started_at DESC;

SELECT 'D-707 loop tables created' AS done;
