-- D-521 — Confirm statement_timeout per role (authenticator/postgrest/anon)
-- to be precise about WHICH timeout the panel was hitting.
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-521 §F] statement_timeout per role:';
  FOR r IN
    SELECT rolname, rolconfig
    FROM pg_roles
    WHERE rolname IN ('authenticator','authenticated','anon','service_role','postgres')
    ORDER BY rolname
  LOOP RAISE NOTICE '  role=% config=%', r.rolname, r.rolconfig; END LOOP;

  RAISE NOTICE '[D-521 §F.1] session default statement_timeout:';
  FOR r IN SELECT current_setting('statement_timeout') AS t
  LOOP RAISE NOTICE '  current_session=%', r.t; END LOOP;
END $$;
