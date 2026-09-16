-- §15.10 Critical #1 — voice reconciliation (May 12, 2026).
-- Per CEO Q3 answer: Log All Picks should auto-fill discretionary stake on
-- SKIP_PRICE picks (the user wants the row logged but Kelly says no). Default
-- $5 — a small token amount that keeps the bet tracked without claiming an
-- edge the math doesn't support.

ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS discretionary_stake NUMERIC(10,2) NOT NULL DEFAULT 5.00
    CHECK (discretionary_stake >= 0);

COMMENT ON COLUMN public.user_preferences.discretionary_stake IS
  'Per-user default stake (USD) auto-filled when Log All Picks logs a '
  'SKIP_PRICE pick — Kelly says the price is too steep but the user wants '
  'a tracker row anyway. §15.10 Critical #1 Phase 2 (May 12, 2026).';
