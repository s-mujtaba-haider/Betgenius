-- D-306 Phase 2 + 3 (2026-05-25) — autonomous orchestrator infrastructure.
--
-- 4 tables + management RPCs + hard-rules scanner. Per
-- /docs/loop/architecture/orchestrator_design.md.
--
-- Rollback:
--   DROP TABLE IF EXISTS cache_orchestrator_alerts, cache_ceo_approvals,
--                        cache_orchestrator_results, cache_orchestrator_task_queue CASCADE;
--   DROP FUNCTION IF EXISTS scan_task_hard_rules, enqueue_task, get_next_pending_task,
--                          mark_task_running, mark_task_completed, mark_task_blocked,
--                          approve_task, list_blocked_tasks;

-- ============================================================
-- TABLE — orchestrator_task_queue
-- ============================================================
CREATE TABLE IF NOT EXISTS public.cache_orchestrator_task_queue (
  task_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_name TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'pending',
  requires_ceo_approval BOOLEAN NOT NULL DEFAULT false,
  hard_rule_violations JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  result_summary JSONB,
  error_log TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT valid_status CHECK (status IN ('pending','running','completed','failed','blocked'))
);
CREATE INDEX IF NOT EXISTS idx_orch_queue_status ON public.cache_orchestrator_task_queue (status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_orch_queue_batch ON public.cache_orchestrator_task_queue (batch_name);

ALTER TABLE public.cache_orchestrator_task_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS orch_queue_service_all ON public.cache_orchestrator_task_queue;
CREATE POLICY orch_queue_service_all ON public.cache_orchestrator_task_queue FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS orch_queue_auth_read ON public.cache_orchestrator_task_queue;
CREATE POLICY orch_queue_auth_read ON public.cache_orchestrator_task_queue FOR SELECT TO authenticated USING (true);

-- ============================================================
-- TABLE — orchestrator_results
-- ============================================================
CREATE TABLE IF NOT EXISTS public.cache_orchestrator_results (
  result_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES public.cache_orchestrator_task_queue(task_id) ON DELETE CASCADE,
  ship_name TEXT,
  grade TEXT,
  artifacts_produced JSONB DEFAULT '[]'::jsonb,
  code_committed BOOLEAN DEFAULT false,
  deploy_required BOOLEAN DEFAULT false,
  deploy_approved BOOLEAN DEFAULT false,
  cardinal_violations TEXT[],
  honest_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orch_results_task ON public.cache_orchestrator_results (task_id);

ALTER TABLE public.cache_orchestrator_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS orch_results_service_all ON public.cache_orchestrator_results;
CREATE POLICY orch_results_service_all ON public.cache_orchestrator_results FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS orch_results_auth_read ON public.cache_orchestrator_results;
CREATE POLICY orch_results_auth_read ON public.cache_orchestrator_results FOR SELECT TO authenticated USING (true);

-- ============================================================
-- TABLE — ceo_approvals
-- ============================================================
CREATE TABLE IF NOT EXISTS public.cache_ceo_approvals (
  approval_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES public.cache_orchestrator_task_queue(task_id) ON DELETE CASCADE,
  approved_by TEXT NOT NULL,
  approval_note TEXT,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id)
);

ALTER TABLE public.cache_ceo_approvals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ceo_appr_service_all ON public.cache_ceo_approvals;
CREATE POLICY ceo_appr_service_all ON public.cache_ceo_approvals FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS ceo_appr_auth_read ON public.cache_ceo_approvals;
CREATE POLICY ceo_appr_auth_read ON public.cache_ceo_approvals FOR SELECT TO authenticated USING (true);

-- ============================================================
-- TABLE — orchestrator_alerts
-- ============================================================
CREATE TABLE IF NOT EXISTS public.cache_orchestrator_alerts (
  alert_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  severity TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  title TEXT NOT NULL,
  details JSONB,
  resolved BOOLEAN NOT NULL DEFAULT false,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT valid_severity CHECK (severity IN ('info','warning','critical','hard_alert'))
);
CREATE INDEX IF NOT EXISTS idx_orch_alerts_severity ON public.cache_orchestrator_alerts (severity, resolved, created_at DESC);

ALTER TABLE public.cache_orchestrator_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS orch_alerts_service_all ON public.cache_orchestrator_alerts;
CREATE POLICY orch_alerts_service_all ON public.cache_orchestrator_alerts FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS orch_alerts_auth_read ON public.cache_orchestrator_alerts;
CREATE POLICY orch_alerts_auth_read ON public.cache_orchestrator_alerts FOR SELECT TO authenticated USING (true);

-- ============================================================
-- FUNCTION — scan_task_hard_rules (Phase 3 hard rules engine)
-- ============================================================
-- Per design doc: 4 categories of hard rules. SQL-side scanner so it's
-- guaranteed to run before any task hits Claude API.
CREATE OR REPLACE FUNCTION scan_task_hard_rules(p_prompt TEXT)
RETURNS TABLE (blocked BOOLEAN, violations TEXT[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_violations TEXT[] := ARRAY[]::TEXT[];
BEGIN
  -- Category 1: keyword-blocked
  IF p_prompt ~* '\bdeploy\s+to\s+(prod|production)\b' OR p_prompt ~* '\bvercel\s+--prod\b' THEN
    v_violations := array_append(v_violations, 'production_deploy_keyword');
  END IF;
  IF p_prompt ~* '\bALTER\s+(WEIGHTS|algorithm_weights)\b' OR p_prompt ~* 'UPDATE\s+algorithm_weights\b' THEN
    v_violations := array_append(v_violations, 'weight_mutation');
  END IF;
  IF p_prompt ~* 'UPDATE\s+pick_history\b' AND p_prompt !~* 'WHERE\s+id\s*=' THEN
    v_violations := array_append(v_violations, 'mass_pick_history_update');
  END IF;
  IF p_prompt ~* 'DELETE\s+FROM\s+pick_history\b' OR p_prompt ~* 'DELETE\s+FROM\s+recommendations_cache\b' THEN
    v_violations := array_append(v_violations, 'pick_deletion');
  END IF;
  IF p_prompt ~* '\bsupabase\s+functions\s+deploy\b.*(process-games|resolve-picks|fetch-odds|fetch-weather)' THEN
    v_violations := array_append(v_violations, 'critical_function_deploy');
  END IF;

  -- Category 4: irreversible
  IF p_prompt ~* '\bDROP\s+TABLE\b' OR p_prompt ~* '\bTRUNCATE\s+\w' THEN
    v_violations := array_append(v_violations, 'irreversible_ddl');
  END IF;
  IF p_prompt ~* '\bgit\s+push\s+--force\b' OR p_prompt ~* '--no-verify' OR p_prompt ~* '--no-gpg-sign' THEN
    v_violations := array_append(v_violations, 'irreversible_git');
  END IF;

  -- Category 3: safety (auth/payment)
  IF p_prompt ~* '\b(stripe|billing|subscription|auth_user|users\s+table)\b' AND p_prompt ~* '(UPDATE|DELETE|INSERT|deploy)' THEN
    v_violations := array_append(v_violations, 'auth_or_payment_path');
  END IF;

  -- Category 2: resource (signal-only at scan time; runtime enforcement
  -- in execution engine)
  IF p_prompt ~* '\bbackfill.*(odds|outcomes).*api\b' THEN
    v_violations := array_append(v_violations, 'odds_api_credit_warning');
  END IF;

  RETURN QUERY SELECT array_length(v_violations, 1) > 0, v_violations;
END;
$$;

REVOKE EXECUTE ON FUNCTION scan_task_hard_rules(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scan_task_hard_rules(TEXT) TO service_role, authenticated;

-- ============================================================
-- FUNCTION — enqueue_task
-- Auto-scans against hard rules and sets requires_ceo_approval +
-- hard_rule_violations on insert.
-- ============================================================
CREATE OR REPLACE FUNCTION enqueue_task(
  p_batch_name TEXT,
  p_prompt TEXT,
  p_priority INTEGER DEFAULT 5
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_task_id UUID;
  v_scan RECORD;
BEGIN
  SELECT * INTO v_scan FROM scan_task_hard_rules(p_prompt);
  INSERT INTO cache_orchestrator_task_queue
    (batch_name, prompt_text, priority, status, requires_ceo_approval, hard_rule_violations)
  VALUES (
    p_batch_name,
    p_prompt,
    p_priority,
    CASE WHEN v_scan.blocked THEN 'blocked' ELSE 'pending' END,
    v_scan.blocked,
    to_jsonb(v_scan.violations)
  )
  RETURNING task_id INTO v_task_id;
  RETURN v_task_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION enqueue_task(TEXT, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enqueue_task(TEXT, TEXT, INTEGER) TO service_role, authenticated;

-- ============================================================
-- FUNCTION — get_next_pending_task
-- FIFO by (priority, created_at). Skips blocked unless approved.
-- ============================================================
CREATE OR REPLACE FUNCTION get_next_pending_task()
RETURNS TABLE (
  task_id UUID,
  batch_name TEXT,
  prompt_text TEXT,
  priority INTEGER,
  requires_ceo_approval BOOLEAN,
  hard_rule_violations JSONB,
  has_approval BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    q.task_id, q.batch_name, q.prompt_text, q.priority,
    q.requires_ceo_approval, q.hard_rule_violations,
    EXISTS(SELECT 1 FROM cache_ceo_approvals a WHERE a.task_id = q.task_id) AS has_approval
  FROM cache_orchestrator_task_queue q
  WHERE q.status = 'pending'
     OR (q.status = 'blocked' AND EXISTS(SELECT 1 FROM cache_ceo_approvals a WHERE a.task_id = q.task_id))
  ORDER BY q.priority ASC, q.created_at ASC
  LIMIT 1;
END;
$$;

REVOKE EXECUTE ON FUNCTION get_next_pending_task() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_next_pending_task() TO service_role, authenticated;

-- ============================================================
-- FUNCTION — mark_task_running / mark_task_completed / mark_task_blocked
-- ============================================================
CREATE OR REPLACE FUNCTION mark_task_running(p_task_id UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE cache_orchestrator_task_queue
  SET status = 'running', started_at = now()
  WHERE task_id = p_task_id AND status IN ('pending','blocked');
END; $$;
GRANT EXECUTE ON FUNCTION mark_task_running(UUID) TO service_role;

CREATE OR REPLACE FUNCTION mark_task_completed(p_task_id UUID, p_summary JSONB) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE cache_orchestrator_task_queue
  SET status = 'completed', completed_at = now(), result_summary = p_summary
  WHERE task_id = p_task_id;
END; $$;
GRANT EXECUTE ON FUNCTION mark_task_completed(UUID, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION mark_task_failed(p_task_id UUID, p_error TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE cache_orchestrator_task_queue
  SET status = 'failed', completed_at = now(), error_log = p_error
  WHERE task_id = p_task_id;
END; $$;
GRANT EXECUTE ON FUNCTION mark_task_failed(UUID, TEXT) TO service_role;

-- ============================================================
-- FUNCTION — approve_task (CEO can call)
-- ============================================================
CREATE OR REPLACE FUNCTION approve_task(p_task_id UUID, p_note TEXT DEFAULT NULL)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id UUID;
BEGIN
  INSERT INTO cache_ceo_approvals (task_id, approved_by, approval_note)
  VALUES (p_task_id, COALESCE(current_setting('request.jwt.claim.email', true), 'CEO'), p_note)
  ON CONFLICT (task_id) DO UPDATE SET approval_note = EXCLUDED.approval_note, approved_at = now()
  RETURNING approval_id INTO v_id;
  -- When approved, mark task pending (was blocked) so execute can pick it up
  UPDATE cache_orchestrator_task_queue SET status = 'pending'
   WHERE task_id = p_task_id AND status = 'blocked';
  RETURN v_id;
END; $$;
GRANT EXECUTE ON FUNCTION approve_task(UUID, TEXT) TO service_role, authenticated;

-- ============================================================
-- FUNCTION — list_blocked_tasks (CEO dashboard query)
-- ============================================================
CREATE OR REPLACE FUNCTION list_blocked_tasks()
RETURNS TABLE (
  task_id UUID, batch_name TEXT, priority INTEGER,
  prompt_preview TEXT, violations JSONB, created_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  SELECT q.task_id, q.batch_name, q.priority,
         left(q.prompt_text, 200)::TEXT,
         q.hard_rule_violations,
         q.created_at
  FROM cache_orchestrator_task_queue q
  WHERE q.status = 'blocked'
    AND NOT EXISTS (SELECT 1 FROM cache_ceo_approvals a WHERE a.task_id = q.task_id)
  ORDER BY q.priority ASC, q.created_at ASC;
END; $$;
GRANT EXECUTE ON FUNCTION list_blocked_tasks() TO service_role, authenticated;

COMMENT ON TABLE public.cache_orchestrator_task_queue IS
  'D-306: autonomous orchestrator task queue. enqueue via enqueue_task() RPC; hard rules auto-scan on insert.';
