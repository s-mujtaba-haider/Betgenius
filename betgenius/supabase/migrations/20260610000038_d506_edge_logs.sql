DO $$
DECLARE r RECORD;
BEGIN
  -- Check if edge function logs are accessible from the SQL layer
  RAISE NOTICE '[D-506] log schemas:';
  FOR r IN SELECT schema_name FROM information_schema.schemata
   WHERE schema_name IN ('_analytics','analytics','edge_runtime','supabase_functions') ORDER BY 1
  LOOP RAISE NOTICE '  schema: %', r.schema_name; END LOOP;

  -- Check pick_history view possibility
  RAISE NOTICE '[D-506] pick_history kind in pg_class:';
  FOR r IN SELECT relkind, relname FROM pg_class WHERE relname='pick_history'
  LOOP RAISE NOTICE '  relkind=% (r=table,v=view,m=matview) relname=%', r.relkind, r.relname; END LOOP;

  -- Are there any RLS policies on pick_history (informational)?
  RAISE NOTICE '[D-506] pick_history policies (for context — service_role bypasses):';
  FOR r IN SELECT policyname, cmd, roles, qual FROM pg_policies
   WHERE schemaname='public' AND tablename='pick_history'
  LOOP RAISE NOTICE '  policy % cmd=% roles=% qual=%', r.policyname, r.cmd, r.roles, COALESCE(r.qual,'<null>'); END LOOP;

  -- Find recent net._http_response calls to functions/v1/resolve-picks to see history
  RAISE NOTICE '[D-506] recent net._http_response to resolve-picks/cron jobs:';
  FOR r IN
    SELECT id, status_code, content_type, length(content::text) AS blen,
           substring(content::text,1,300) AS body_head, created
    FROM net._http_response
    WHERE created > NOW() - INTERVAL '24 hours'
    ORDER BY created DESC LIMIT 8
  LOOP
    RAISE NOTICE '  rid=% status=% blen=% body[0..300]=%',
      r.id, r.status_code, r.blen, r.body_head;
  END LOOP;
END $$;
