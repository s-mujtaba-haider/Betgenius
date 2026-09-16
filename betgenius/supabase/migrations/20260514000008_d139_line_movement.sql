-- D-139 Tier 2 #5 score_line_movement V0 (CEO §19.3, May 13, 2026).
-- Extends D-137's cache_game_lines with spread_line_t0 (first-observed
-- spread, immutable via BEFORE-UPDATE trigger). Adds 3 column writes
-- to pick_history / recommendations_cache / algorithm_weights.
-- Pre-audit confirmed clean state (migration 20260513000061).
-- Paired §1.12 verification: 20260514000009_d139_verification.sql.
-- =============================================================================

-- (1) Column add. NULLABLE — NULL means "never observed before"; factor
-- defaults to 0 in that case (graceful degradation).
ALTER TABLE public.cache_game_lines
  ADD COLUMN IF NOT EXISTS spread_line_t0 NUMERIC;

COMMENT ON COLUMN public.cache_game_lines.spread_line_t0 IS
  'D-139 Tier 2 #5 (May 13, 2026). FIRST-observed spread_line for this '
  'event_id, immutable via cache_game_lines_preserve_t0_trigger. fetch-odds '
  'writer includes spread_line_t0 = current spread_line in every payload; '
  'on INSERT this populates t0; on UPDATE the trigger restores OLD.spread_line_t0 '
  'so the original first-observation value is preserved. Read by '
  'process-games score_line_movement factor to compute spread movement.';

-- (2) Backfill existing rows: rows from D-137 deploy (~19:44 UTC) to D-139
-- deploy (~now). The "first observed" semantics are imprecise for these rows
-- (they were already in cache when we added the column), but treating
-- current spread as t0 is the only honest choice — it means line_movement
-- factor returns 0 on these rows for the first cron tick (no movement
-- observed yet) and starts producing signal when fetch-odds writes a new
-- spread that differs from the backfilled t0.
UPDATE public.cache_game_lines
  SET spread_line_t0 = spread_line
  WHERE spread_line_t0 IS NULL AND spread_line IS NOT NULL;

-- (3) Trigger: preserve OLD.spread_line_t0 on every UPDATE so the first-
-- observed value is immutable. INSERT path is unaffected (no OLD row).
CREATE OR REPLACE FUNCTION public.preserve_spread_line_t0()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.spread_line_t0 IS NOT NULL THEN
    NEW.spread_line_t0 := OLD.spread_line_t0;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cache_game_lines_preserve_t0_trigger ON public.cache_game_lines;
CREATE TRIGGER cache_game_lines_preserve_t0_trigger
  BEFORE UPDATE ON public.cache_game_lines
  FOR EACH ROW EXECUTE FUNCTION public.preserve_spread_line_t0();

COMMENT ON FUNCTION public.preserve_spread_line_t0() IS
  'D-139 Tier 2 #5. BEFORE-UPDATE trigger function that preserves the '
  'first-observed spread_line_t0 across all subsequent UPDATEs. fetch-odds '
  'writer can naively include spread_line_t0 in every payload; trigger '
  'enforces immutability database-side.';

-- (4) Factor columns.
ALTER TABLE public.pick_history
  ADD COLUMN IF NOT EXISTS score_line_movement INT NOT NULL DEFAULT 0;
COMMENT ON COLUMN public.pick_history.score_line_movement IS
  'D-139 Tier 2 #5 (May 13, 2026). Vegas line movement signal: bonus when '
  'line moves TOWARD the pick, penalty when it moves AGAINST. Favored-team-'
  'only policy (matches D-137 blowout_risk). Side-flipped on under picks. '
  'Magnitude buckets: |move|>1.5 → ±10, >0.75 → ±5, >0.25 → ±2, else 0.';

ALTER TABLE public.recommendations_cache
  ADD COLUMN IF NOT EXISTS score_line_movement NUMERIC NOT NULL DEFAULT 0;

ALTER TABLE public.algorithm_weights
  ADD COLUMN IF NOT EXISTS w_line_movement NUMERIC NOT NULL DEFAULT 1.0
    CHECK (w_line_movement >= 0);
COMMENT ON COLUMN public.algorithm_weights.w_line_movement IS
  'Multiplier on score_line_movement before adding to finalScore. Starting '
  'value 1.0 per CEO "gut-bucket" philosophy. Re-tune via D-118 calibration '
  'loop after ~2 weeks of organic data (Finals 3-week constraint applies — '
  'line movement signal more abundant in regular season).';
