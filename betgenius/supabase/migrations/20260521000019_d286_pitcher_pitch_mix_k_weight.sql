-- D-286 SHIP 2 (2026-05-21) — enable pitcher_pitch_mix_k factor weight.
--
-- Wired in scorePitcherStrikeouts: opposing pitcher's breaking-ball
-- usage (SL + CU + FC + ST + SV) from cache_statcast_pitcher_arsenal.
-- League avg ~30%; high-breaking pitchers (>40%) generate more K's.
--
-- Bucket math (gated total_pitches ≥ 300):
--   breaking_ball_pct ≥ 50% → +6 (boost over)
--   ≥ 40% → +3
--   ≥ 35% → +1
--   ≤ 25% → -1
--   ≤ 20% → -3
--   ≤ 15% → -6 (suppress over)
--
-- Note: Baseball Savant pitch-arsenal-stats CSV only reports pitches
-- with meaningful sample. Pitchers with partial data (e.g., only FF
-- shown) will have breaking_ball_pct=0 — gracefully reads as low-K
-- profile. This is a known limitation; D-287+ may add completeness gating.
--
-- Rollback:
--   UPDATE public.algorithm_weights SET w_mlb_pitcher_pitch_mix_k = 0.0 WHERE id = 1;

UPDATE public.algorithm_weights
SET w_mlb_pitcher_pitch_mix_k = 1.0
WHERE id = 1;

COMMENT ON COLUMN public.algorithm_weights.w_mlb_pitcher_pitch_mix_k IS
  'D-286 SHIP 2 WIRED: pitcher breaking-ball usage % factor in '
  'scorePitcherStrikeouts. Bucket ±6 around league avg ~30%. '
  'Gated total_pitches ≥ 300. Data source cache_statcast_pitcher_arsenal '
  '(Baseball Savant pitch-arsenal-stats CSV). Weight 1.0.';
