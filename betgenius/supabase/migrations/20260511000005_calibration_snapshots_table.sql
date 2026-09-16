-- Real-money calibration tracking — schema + input view (May 11, 2026).
--
-- Goal: measure real-money hit rate against algorithm confidence by tier /
-- prop_type / factor_presence over rolling 7d / 30d / all_time windows.
-- Daily snapshot written by write-calibration-snapshot edge function via
-- cron jobid 13 (11:15 UTC daily). Bootstrapped May 7-11 manually.
--
-- §19.3 NOT triggered: no scoring math touched. Pure additive measurement
-- infrastructure: new table + new view + (next migrations) new functions
-- and cron.
--
-- Join correctness note: real_money_bets view doesn't expose game_date
-- directly (only bet_game_date_et TEXT + matched_pick_game_date TEXT). Using
-- matched_pick_id for the pick_history join — leverages rmb's existing
-- natural-key match (player_name + prop_type + line + pick_side + ±1-day
-- DATE arithmetic via C33 Phase 6 view recreation). Bets with is_matched=false
-- are excluded from calibration (no algorithm confidence to calibrate against).

CREATE TABLE IF NOT EXISTS public.calibration_snapshots (
  id                    BIGSERIAL PRIMARY KEY,
  snapshot_date         DATE NOT NULL,                -- when snapshot taken
  window_start          DATE NOT NULL,                -- bet placement window start
  window_end            DATE NOT NULL,                -- bet placement window end
  window_type           TEXT NOT NULL CHECK (window_type IN ('rolling_7d','rolling_30d','all_time')),
  metric_type           TEXT NOT NULL CHECK (metric_type IN ('overall','tier','prop_type','factor_presence')),
  metric_key            TEXT NOT NULL,                -- e.g. '70-79', 'points', 'score_player_injury_present'
  bets_count            INTEGER NOT NULL,             -- bets placed in window matching this bucket
  bets_resolved         INTEGER NOT NULL,             -- bets with hit IS NOT NULL (excl. voided)
  bets_hit              INTEGER NOT NULL,             -- bets where hit = true
  hit_rate              NUMERIC(5,4),                 -- bets_hit / bets_resolved (NULL if resolved=0)
  avg_confidence        NUMERIC(5,2),                 -- mean confidence of bucket bets
  backtest_hit_rate     NUMERIC(5,4),                 -- reference from synthetic backtest at same tier (NULL for non-tier)
  calibration_delta     NUMERIC(6,4),                 -- hit_rate - (avg_confidence/100) for tiers; NULL otherwise
  sample_size_warning   BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calibration_snapshots_lookup
  ON public.calibration_snapshots (window_type, metric_type, metric_key, snapshot_date DESC);

COMMENT ON TABLE public.calibration_snapshots IS
  'Daily snapshot of real-money calibration metrics. Written by '
  'write-calibration-snapshot cron job at 11:15 UTC daily (after resolve-picks '
  'settles overnight bets). Each snapshot writes ~10-30 rows across the 3 '
  'window_types x 4 metric_types. History accumulates; never DELETE — read '
  'latest per (window_type, metric_type, metric_key, snapshot_date DESC).';

-- calibration_input: helper view normalizing real-money bets + matched pick
-- scoring fields into one tidy shape for the compute_calibration_snapshot
-- function. SECURITY INVOKER per RLS convention.

CREATE OR REPLACE VIEW public.calibration_input
WITH (security_invoker = true) AS
SELECT
  rmb.bet_id,
  rmb.placed_at,
  rmb.placed_at::date                                 AS bet_date,
  rmb.player_name,
  rmb.prop_type,
  rmb.line,
  rmb.pick_side,
  rmb.stake,
  rmb.odds,
  rmb.status                                          AS bet_status,
  rmb.matched_pick_id,
  rmb.matched_pick_confidence                         AS confidence,
  ph.score_player_injury,
  ph.score_l5,
  ph.score_season,
  ph.score_recent_form,
  ph.hit,
  ph.voided,
  ph.resolved_at,
  CASE
    WHEN rmb.matched_pick_confidence >= 90 THEN '90+'
    WHEN rmb.matched_pick_confidence >= 80 THEN '80-89'
    WHEN rmb.matched_pick_confidence >= 70 THEN '70-79'
    WHEN rmb.matched_pick_confidence >= 60 THEN '60-69'
    ELSE '<60'
  END                                                 AS confidence_tier
FROM public.real_money_bets rmb
LEFT JOIN public.pick_history ph
  ON ph.id = rmb.matched_pick_id
WHERE rmb.is_matched = true
  AND (ph.voided IS NOT TRUE OR ph.voided IS NULL);

COMMENT ON VIEW public.calibration_input IS
  'Normalized join of real_money_bets x pick_history for calibration tracking. '
  'Uses matched_pick_id from real_money_bets (cleaner than re-doing natural-key '
  'match). Excludes voided picks (DNP) and bets with is_matched=false (no '
  'algorithm confidence to calibrate against).';
