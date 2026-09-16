-- D-365 — vault prefix-only probe. Returns ONLY length + first-8-chars of
-- vault.decrypted_secrets values for the two auth-relevant names. Does NOT
-- return raw secret content. Used to diagnose env-vs-vault mismatch.
-- Rollback: DROP FUNCTION IF EXISTS public.d365_vault_prefix_only();

CREATE OR REPLACE FUNCTION public.d365_vault_prefix_only()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault AS $$
DECLARE
  v_b text;
  v_s text;
  v_out jsonb;
BEGIN
  SELECT decrypted_secret INTO v_b FROM vault.decrypted_secrets
    WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  SELECT decrypted_secret INTO v_s FROM vault.decrypted_secrets
    WHERE name = 'SUPABASE_SERVICE_ROLE_KEY' OR name = 'service_role_key' OR name = 'SERVICE_ROLE_KEY' LIMIT 1;
  v_out := jsonb_build_object(
    'vault_BACKFILL_AUTH_TOKEN', jsonb_build_object('length', length(v_b), 'prefix', left(v_b, 8)),
    'vault_SERVICE_ROLE_KEY', jsonb_build_object('length', length(v_s), 'prefix', left(v_s, 8))
  );
  RETURN v_out;
END $$;

GRANT EXECUTE ON FUNCTION public.d365_vault_prefix_only() TO service_role, authenticated;
