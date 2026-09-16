-- D-596 SHIP 1 — production pipeline for pitch-type matchup signal.
-- D-594 proved the signal exists (corr_edge 0.126 full / 0.30+ at conf>=70).
-- Extend cache_statcast_pitcher_arsenal with usage-weighted per-pitch-type
-- aggregates so the scorer can read them per-pitcher:
--   expected_whiff_pct   = sum(usage × whiff_percent) / sum(usage)
--   expected_k_pct       = sum(usage × k_percent) / sum(usage)
--   expected_put_away    = sum(usage × put_away) / sum(usage)
--
-- The fetcher (fetch-baseball-savant-weekly) computes + writes these on
-- each refresh. Nullable for back-snapshots taken pre-D-596.

ALTER TABLE public.cache_statcast_pitcher_arsenal
  ADD COLUMN IF NOT EXISTS expected_whiff_pct NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS expected_k_pct     NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS expected_put_away  NUMERIC(5,2);

COMMENT ON COLUMN public.cache_statcast_pitcher_arsenal.expected_whiff_pct IS
  'D-596 (2026-06-19) — usage-weighted whiff_percent across the pitcher''s pitch arsenal. = SUM(pitch_usage × whiff_percent per pitch type) / SUM(pitch_usage). Source: Baseball Savant /leaderboard/pitch-arsenal-stats CSV. Refreshed weekly via fetch-baseball-savant-weekly. Consumed by score_pitch_type_matchup factor in scorePitcherStrikeouts (D-596 SHIP 2). Nullable on back-snapshot rows pre-D-596; the fetcher writes it forward.';

COMMENT ON COLUMN public.cache_statcast_pitcher_arsenal.expected_k_pct IS
  'D-596 — usage-weighted k_percent across the arsenal. Pitch-type-specific K conversion rate, weighted by the pitcher''s actual usage. The D-594 §C.1 finding: corr(this, K - line) = 0.126 (full corpus) / 0.306 (conf>=70). Book-uncaptured per D-594.';

COMMENT ON COLUMN public.cache_statcast_pitcher_arsenal.expected_put_away IS
  'D-596 — usage-weighted put_away across the arsenal. The decisive signal: corr(this, K - line) = 0.122 (full) / 0.334 (conf>=70). Put-away % captures the pitcher''s ability to convert 2-strike counts into Ks, weighted by what they actually throw. Strongest single-input residual signal D-594 found.';
