#!/usr/bin/env -S deno run --no-check --allow-net --allow-env --allow-read
// Read-only: does any event_id have more than one commence_time calendar date?

import { closePool, getDbFromEnv } from "../lib/env.ts";

const db = getDbFromEnv();
try {
  const rows = await db.query<{ event_id: string; distinct_dates: string }>(
    `SELECT event_id, COUNT(DISTINCT commence_time::date)::text AS distinct_dates
     FROM cache_mlb_historical_odds
     GROUP BY event_id
     HAVING COUNT(DISTINCT commence_time::date) > 1`,
  );
  const totalEvents = await db.query<{ n: string }>(
    `SELECT COUNT(DISTINCT event_id)::text AS n FROM cache_mlb_historical_odds`,
  );
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    eventsWithMultipleCommenceDates: rows.length,
    sample: rows.slice(0, 20),
    distinctEventsInWarehouse: totalEvents[0]?.n ?? null,
  }, null, 2));
} finally {
  await closePool();
}
