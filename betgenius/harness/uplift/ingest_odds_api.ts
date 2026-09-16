// Phase 1 uplift — fill the two markets the odds warehouse never held.
//
// `batter_runs_scored` and `batter_strikeouts` have ZERO rows in
// cache_mlb_historical_odds in any season, so neither could be judged at all:
// not "failed", un-measurable. The provider does carry both, so this pulls them
// from The Odds API historical endpoint into the same shape dump_odds.ts
// produces, and nothing downstream needs to know where a candidate came from.
//
// Read-only with respect to the database: event ids and commence times come
// from cache_mlb_historical_events, nothing is written back.
//
//   deno run --allow-net --allow-env --allow-read --allow-write \
//     harness/uplift/ingest_odds_api.ts --markets=batter_runs_scored \
//     --from=2024-04-01 --to=2024-10-01
//
// Quota: the endpoint bills 10 credits per market per region per event, so one
// market over one MLB season is ~24k credits. --dry prints the bill and stops.
import { closePool, getDbFromEnv, loadHarnessEnv } from "../lib/env.ts";

const API = "https://api.the-odds-api.com/v4/historical/sports/baseball_mlb";
const CONC = 6;

interface Ev { event_id: string; commence_time: string; game_pk: number }

function arg(name: string, dflt = ""): string {
  const a = Deno.args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
}

loadHarnessEnv();
const KEY = Deno.env.get("ODDS_API_KEY") ?? Deno.env.get("THE_ODDS_API_KEY") ?? "";
if (!KEY) throw new Error("[ingest] ODDS_API_KEY missing from harness/.env");

const markets = arg("markets", "batter_runs_scored").split(",");
const from = arg("from", "2024-04-01");
const to = arg("to", "2024-10-01");
const regions = arg("regions", "us");
const dry = Deno.args.includes("--dry");
const outPath = arg("out", `harness/uplift/data/api_${markets.join("_")}_${from}.jsonl`);

const db = getDbFromEnv();
const events = await db.query<Ev>(
  `select event_id, commence_time::text as commence_time, game_pk
     from cache_mlb_historical_events
    where game_pk is not null
      and commence_time >= $1::timestamptz and commence_time < $2::timestamptz
    order by commence_time`,
  [from, to],
);
await closePool();
console.log(`[ingest] ${events.length} events ${from} -> ${to}`);
console.log(`[ingest] estimated cost ~${events.length * markets.length * 10} credits`);
if (dry) Deno.exit(0);

// resume: skip events already written
const done = new Set<string>();
try {
  const prev = await Deno.readTextFile(outPath);
  for (const line of prev.split("\n")) {
    if (!line.trim()) continue;
    try {
      done.add(JSON.parse(line).event_id);
    } catch { /* partial last line */ }
  }
  console.log(`[ingest] resuming, ${done.size} events already stored`);
} catch { /* first run */ }

await Deno.mkdir(outPath.substring(0, outPath.lastIndexOf("/")), { recursive: true });
const file = await Deno.open(outPath, { write: true, create: true, append: true });
const enc = new TextEncoder();

/** Snapshot an hour before first pitch: the last number a bettor could take. */
function snapshotFor(commence: string): string {
  return new Date(new Date(commence).getTime() - 3600_000).toISOString().replace(/\.\d+Z$/, "Z");
}

let ok = 0, empty = 0, fail = 0, remaining = "";
const todo = events.filter((e) => !done.has(e.event_id));

async function one(e: Ev): Promise<void> {
  const url = `${API}/events/${e.event_id}/odds?apiKey=${KEY}&regions=${regions}` +
    `&markets=${markets.join(",")}&oddsFormat=american&date=${snapshotFor(e.commence_time)}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url);
      remaining = r.headers.get("x-requests-remaining") ?? remaining;
      if (r.status === 404 || r.status === 422) {
        empty++;
        await r.body?.cancel();
        return;
      }
      if (!r.ok) {
        if (attempt === 3) {
          fail++;
          console.warn(`[ingest] ${e.event_id} HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
          return;
        }
        await r.body?.cancel();
        await new Promise((s) => setTimeout(s, 1500 * attempt));
        continue;
      }
      const body = await r.json();
      const data = body?.data;
      const books = data?.bookmakers ?? [];
      if (!books.length) {
        empty++;
        return;
      }
      await file.write(enc.encode(JSON.stringify({
        event_id: e.event_id,
        game_pk: e.game_pk,
        commence_time: data.commence_time ?? e.commence_time,
        home_team: data.home_team,
        away_team: data.away_team,
        snapshot: body.timestamp,
        bookmakers: books,
      }) + "\n"));
      ok++;
      return;
    } catch (err) {
      if (attempt === 3) {
        fail++;
        console.warn(`[ingest] ${e.event_id} ${err instanceof Error ? err.message : err}`);
        return;
      }
      await new Promise((s) => setTimeout(s, 1500 * attempt));
    }
  }
}

for (let i = 0; i < todo.length; i += CONC) {
  await Promise.all(todo.slice(i, i + CONC).map(one));
  if ((i / CONC) % 20 === 0) {
    console.log(`[ingest] ${i + CONC}/${todo.length} ok=${ok} empty=${empty} fail=${fail} ` +
      `credits_left=${remaining}`);
  }
}
file.close();
console.log(`[ingest] done ok=${ok} empty=${empty} fail=${fail} credits_left=${remaining} -> ${outPath}`);
