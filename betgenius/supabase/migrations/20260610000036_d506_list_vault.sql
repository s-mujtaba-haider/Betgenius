DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-506] vault secret names:';
  FOR r IN SELECT name, length(decrypted_secret) AS keylen
           FROM vault.decrypted_secrets ORDER BY name
  LOOP
    RAISE NOTICE '  - % (len=%)', r.name, r.keylen;
  END LOOP;
END $$;
