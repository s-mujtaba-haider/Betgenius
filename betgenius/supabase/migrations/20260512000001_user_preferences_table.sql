-- §15.10 Critical #2 — user_preferences table (May 12, 2026).
--
-- Why: localStorage stores Kelly aggressiveness + bankroll + my_books
-- per-device, not synced to user account. CEO real-world example May 12:
-- phone shows quarter Kelly + $1000 bankroll while laptop shows full
-- Kelly + $500 bankroll on the same logged-in account. Subscriber-launch
-- blocker — paying users cannot have different stakes on different
-- devices.
--
-- This migration creates user_preferences keyed on auth.users(id).
-- localStorage stays as cache (anonymous-mode fallback + first-paint
-- before async hydration). Server is the source of truth on every
-- authenticated read.
--
-- RLS: users SELECT/INSERT/UPDATE their own row only. Admin (per
-- is_admin() from D-041 / migration 20260430000001) can SELECT all
-- rows for support / debugging. No DELETE policy — ON DELETE CASCADE
-- on the FK handles user deletion.
--
-- No seed row: hydration helper in src/lib/user_preferences.ts inserts
-- a row on first authenticated read, populating from current
-- localStorage values so existing users don't lose their settings.

CREATE TABLE IF NOT EXISTS public.user_preferences (
  user_id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  kelly_aggressiveness TEXT NOT NULL DEFAULT 'quarter'
    CHECK (kelly_aggressiveness IN ('quarter', 'half', 'full')),
  bankroll             NUMERIC(10,2) NOT NULL DEFAULT 1000.00
    CHECK (bankroll >= 0),
  my_books             TEXT[] NOT NULL DEFAULT ARRAY['hardrockbet']::TEXT[],
  sport_preference     TEXT NOT NULL DEFAULT 'nba'
    CHECK (sport_preference IN ('nba', 'mlb')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.user_preferences IS
  'Per-user app settings synced across devices. §15.10 Critical #2 fix '
  '(May 12, 2026). localStorage is a cache; this table is source of truth '
  'on every authenticated read. Anonymous users continue using localStorage '
  'directly (no row). One row per authenticated user; auto-created on first '
  'authenticated read by src/lib/user_preferences.ts hydration.';

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.user_preferences_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS user_preferences_set_updated_at_trigger ON public.user_preferences;
CREATE TRIGGER user_preferences_set_updated_at_trigger
  BEFORE UPDATE ON public.user_preferences
  FOR EACH ROW EXECUTE FUNCTION public.user_preferences_set_updated_at();

-- RLS
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_preferences_select_self ON public.user_preferences;
CREATE POLICY user_preferences_select_self ON public.user_preferences
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS user_preferences_insert_self ON public.user_preferences;
CREATE POLICY user_preferences_insert_self ON public.user_preferences
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS user_preferences_update_self ON public.user_preferences;
CREATE POLICY user_preferences_update_self ON public.user_preferences
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- No DELETE policy: rely on ON DELETE CASCADE from auth.users(id) FK.

GRANT SELECT, INSERT, UPDATE ON public.user_preferences TO authenticated;
