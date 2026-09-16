-- D-282 SHIP 1 (2026-05-21) — cache_mlb_batter_splits table.
--
-- Daily snapshot of MLB batter splits vs LHP / RHP. Data source:
-- MLB Stats API GET /api/v1/people/{playerId}/stats?stats=statSplits
-- &sitCodes=vl,vr&group=hitting&season=2026
--
-- Append-daily pattern (PRIMARY KEY (player_id, snapshot_date)) so
-- backtest can reconstruct point-in-time splits.
--
-- Rollback:
--   DROP TABLE public.cache_mlb_batter_splits CASCADE;

CREATE TABLE IF NOT EXISTS public.cache_mlb_batter_splits (
  player_id       integer NOT NULL,
  snapshot_date   date NOT NULL,
  player_name     text,
  -- vs LHP
  vs_lhp_pa       integer,
  vs_lhp_atbats   integer,
  vs_lhp_hits     integer,
  vs_lhp_avg      numeric,
  vs_lhp_obp      numeric,
  vs_lhp_slg      numeric,
  vs_lhp_ops      numeric,
  vs_lhp_hr       integer,
  vs_lhp_tb       integer,
  vs_lhp_rbi      integer,
  -- vs RHP
  vs_rhp_pa       integer,
  vs_rhp_atbats   integer,
  vs_rhp_hits     integer,
  vs_rhp_avg      numeric,
  vs_rhp_obp      numeric,
  vs_rhp_slg      numeric,
  vs_rhp_ops      numeric,
  vs_rhp_hr       integer,
  vs_rhp_tb       integer,
  vs_rhp_rbi      integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS cache_mlb_batter_splits_player_idx
  ON public.cache_mlb_batter_splits(player_id);

ALTER TABLE public.cache_mlb_batter_splits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cache_mlb_batter_splits_authed_read ON public.cache_mlb_batter_splits;
CREATE POLICY cache_mlb_batter_splits_authed_read
  ON public.cache_mlb_batter_splits
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS cache_mlb_batter_splits_service_all ON public.cache_mlb_batter_splits;
CREATE POLICY cache_mlb_batter_splits_service_all
  ON public.cache_mlb_batter_splits
  FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT SELECT ON public.cache_mlb_batter_splits TO authenticated;
GRANT ALL ON public.cache_mlb_batter_splits TO service_role;

COMMENT ON TABLE public.cache_mlb_batter_splits IS
  'D-282 SHIP 1: daily MLB batter split snapshots vs LHP / RHP. '
  'Source: MLB Stats API /people/{id}/stats?stats=statSplits.';
