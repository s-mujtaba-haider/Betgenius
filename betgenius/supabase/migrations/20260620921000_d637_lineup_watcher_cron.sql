-- D-637 SHIP 1 — Cron registration for lineup-confirmation-watcher.
-- ────────────────────────────────────────────────────────────────────
-- Every 10 min during the MLB pre-game-active window. Watcher itself
-- gates per-game by T-4h → first_pitch, so the cron just needs to fire
-- often enough that lineup transitions in the window are detected
-- within ~10 min of posting (subscribers bet ~2-3 h pre-game; 10-min
-- detection latency is well-under the bet-time window).
--
-- Schedule rationale:
--   `*/10 14-23,0-4 * * *` — UTC; covers ET 10:00 → 00:00 next day
--   (when MLB games run). ~96 fires/day; per-fire cost is bounded
--   (only games in T-4h window are polled). Cost ceiling: 15 games ×
--   10-min cadence × 1 HTTP request = ~30K MLB Stats requests/day —
--   inside MLB Stats' implicit no-token-required limit (no rate limit
--   documented; they accept full schedule polls from 1000s of clients).
--
-- Rollback: SELECT cron.unschedule('lineup-confirmation-watcher-10min');

SELECT cron.schedule(
  'lineup-confirmation-watcher-10min',
  '*/10 14-23,0-4 * * *',
  $$
    SELECT net.http_post(
      url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/lineup-confirmation-watcher',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $$
);

DO $$ DECLARE r RECORD; BEGIN
  RAISE NOTICE '[D-637 cron] schedule confirmed:';
  FOR r IN SELECT jobid, jobname, schedule, active FROM cron.job
   WHERE jobname = 'lineup-confirmation-watcher-10min'
  LOOP RAISE NOTICE '  jobid=% name=% sched=% active=%',
    r.jobid, r.jobname, r.schedule, r.active; END LOOP;
END $$;
