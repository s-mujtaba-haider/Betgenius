-- D-272-INF-5 #2 (2026-05-20) — Add DELETE policy on user_preferences.
--
-- D-239 audit found user_preferences had INSERT + SELECT + UPDATE
-- policies but no DELETE policy. Users couldn't self-clean their own
-- preferences row (e.g. on full account reset within app).
--
-- Self-only DELETE via auth.uid() = user_id. Service role retains
-- broader access via existing service_role policy.
--
-- Rollback:
--   DROP POLICY "user_preferences_self_delete" ON public.user_preferences;

DROP POLICY IF EXISTS "user_preferences_self_delete" ON public.user_preferences;
CREATE POLICY "user_preferences_self_delete"
  ON public.user_preferences
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

COMMENT ON POLICY "user_preferences_self_delete" ON public.user_preferences IS
  'D-272-INF-5 #2: authenticated users can delete their own '
  'user_preferences row. auth.uid() must match user_id column.';
