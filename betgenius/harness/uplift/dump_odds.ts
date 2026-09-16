// Phase 1 uplift — build the full priced candidate universe from the odds
// warehouse, read-only.
//
// One row per (event, player, line). The price is taken at the ENTRY snapshot:
// the earliest snapshot the warehouse holds for that event/market that is
// strictly before commence_time. Nothing later than that is ever read, so the
// candidate is point-in-time by construction.
//
// Per candidate the aggregate carries, across the books quoting it at that
// snapshot:
//   impOverMed / impUnderMed  median implied probability  -> the price a normal
//                             account actually gets (this is what we bet at)
//   impOverBest/impUnderBest  best price on the street (reported as sensitivity
//                             only; never used for a verdict)
//   pFairOver                 de-vigged consensus over the books quoting BOTH
//                             sides -- the market's own probability
//
// Medians are taken on implied probability, not on American odds: American odds
// are discontinuous at +/-100 and a median of them is meaningless.
//
//   deno run --allow-net --allow-env --allow-read --allow-write \
//     harness/uplift/dump_odds.ts --market=batter_hits
import { closePool, getDbFromEnv } from "../lib/env.ts";
import { writeCsv } from "./csv.ts";

const FROM = "2024-04-01"; // box scores (the grading source) start here
const TO = "2026-05-24"; // warehouse odds stop here

type Shape = "prop" | "totals" | "twokey";
interface Spec {
  shape: Shape;
  keys: string[]; // market_key(s)
}

const SPECS: Record<string, Spec> = {
  batter_hits: { shape: "prop", keys: ["batter_hits"] },
  batter_total_bases: { shape: "prop", keys: ["batter_total_bases"] },
  batter_home_runs: { shape: "prop", keys: ["batter_home_runs"] },
  batter_rbis: { shape: "prop", keys: ["batter_rbis"] },
  pitcher_strikeouts: { shape: "prop", keys: ["pitcher_strikeouts"] },
  pitcher_outs: { shape: "prop", keys: ["pitcher_outs"] },
  totals: { shape: "totals", keys: ["totals"] },
  h2h: { shape: "twokey", keys: ["h2h__home", "h2h__away"] },
  spreads: { shape: "twokey", keys: ["spreads__home", "spreads__away"] },
};

// American odds -> implied probability, as a SQL expression.
const imp = (c: string) =>
  `case when ${c} is null then null when ${c} < 0 then (-(${c}))::float8/((-(${c}))+100.0) ` +
  `when ${c} > 0 then 100.0/((${c})+100.0) else null end`;

const ENTRY = `
  snap as (
    select event_id, min(snapshot_timestamp) as entry_snap
      from cache_mlb_historical_odds
     where market_key = any($1)
       and snapshot_timestamp < commence_time
       and commence_time >= $2::timestamptz
       and commence_time <  $3::timestamptz
     group by 1
  )`;

const EV = `
  ev as (
    select event_id, game_pk, commence_time, home_team, away_team
      from cache_mlb_historical_events
     where game_pk is not null
  )`;

function sqlProp(): string {
  return `
with ${EV}, ${ENTRY},
px as (
  select o.event_id, o.player_name, o.line::float8 as line, o.bookmaker_key,
         ${imp("o.over_odds")} as io, ${imp("o.under_odds")} as iu
    from cache_mlb_historical_odds o
    join snap s on s.event_id = o.event_id and s.entry_snap = o.snapshot_timestamp
   where o.market_key = any($1)
)
select ev.event_id, ev.game_pk, ev.commence_time, ev.home_team, ev.away_team,
       px.player_name, px.line,
       count(*)::int as n_books,
       count(px.io)::int as n_over,
       count(px.iu)::int as n_under,
       percentile_cont(0.5) within group (order by px.io) as imp_over_med,
       percentile_cont(0.5) within group (order by px.iu) as imp_under_med,
       min(px.io) as imp_over_best,
       min(px.iu) as imp_under_best,
       avg(px.io/nullif(px.io+px.iu,0)) filter (where px.io is not null and px.iu is not null) as p_fair_over,
       count(*) filter (where px.io is not null and px.iu is not null)::int as n_twoway
  from px join ev on ev.event_id = px.event_id
 group by 1,2,3,4,5,6,7`;
}

function sqlTotals(): string {
  return sqlProp(); // identical shape; player_name is '' for game markets
}

// h2h / spreads: the side lives in market_key and only over_odds is populated.
// Home and away are separate rows, paired on (event, book) at the entry snapshot.
function sqlTwoKey(homeKey: string, awayKey: string): string {
  return `
with ${EV}, ${ENTRY},
h as (
  select o.event_id, o.bookmaker_key, o.line::float8 as line, ${imp("o.over_odds")} as ip
    from cache_mlb_historical_odds o
    join snap s on s.event_id = o.event_id and s.entry_snap = o.snapshot_timestamp
   where o.market_key = '${homeKey}'
),
a as (
  select o.event_id, o.bookmaker_key, o.line::float8 as line, ${imp("o.over_odds")} as ip
    from cache_mlb_historical_odds o
    join snap s on s.event_id = o.event_id and s.entry_snap = o.snapshot_timestamp
   where o.market_key = '${awayKey}'
),
px as (
  select h.event_id, h.line, h.bookmaker_key, h.ip as io, a.ip as iu
    from h join a on a.event_id = h.event_id and a.bookmaker_key = h.bookmaker_key
                 and a.line = -h.line
)
select ev.event_id, ev.game_pk, ev.commence_time, ev.home_team, ev.away_team,
       ''::text as player_name, px.line,
       count(*)::int as n_books,
       count(px.io)::int as n_over,
       count(px.iu)::int as n_under,
       percentile_cont(0.5) within group (order by px.io) as imp_over_med,
       percentile_cont(0.5) within group (order by px.iu) as imp_under_med,
       min(px.io) as imp_over_best,
       min(px.iu) as imp_under_best,
       avg(px.io/nullif(px.io+px.iu,0)) filter (where px.io is not null and px.iu is not null) as p_fair_over,
       count(*) filter (where px.io is not null and px.iu is not null)::int as n_twoway
  from px join ev on ev.event_id = px.event_id
 group by 1,2,3,4,5,6,7`;
}

/** Month boundaries [from, to) — the warehouse is too big for one statement. */
function months(from: string, to: string): [string, string][] {
  const out: [string, string][] = [];
  let [y, m] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
  const end = to;
  for (;;) {
    const lo = `${y}-${String(m).padStart(2, "0")}-01`;
    if (lo >= end) break;
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    const hi = `${ny}-${String(nm).padStart(2, "0")}-01`;
    out.push([lo, hi > end ? end : hi]);
    [y, m] = [ny, nm];
  }
  return out;
}

const args = Deno.args.filter((a) => a.startsWith("--market="));
const markets = args.length
  ? args[0].slice("--market=".length).split(",")
  : Object.keys(SPECS);

const db = getDbFromEnv();
await db.query("set statement_timeout = 0");
for (const m of markets) {
  const spec = SPECS[m];
  if (!spec) throw new Error(`unknown market ${m}. valid: ${Object.keys(SPECS).join(", ")}`);
  const sql = spec.shape === "twokey"
    ? sqlTwoKey(spec.keys[0], spec.keys[1])
    : spec.shape === "totals"
    ? sqlTotals()
    : sqlProp();
  const all: Record<string, unknown>[] = [];
  const t0 = Date.now();
  for (const [lo, hi] of months(FROM, TO)) {
    const rows = await db.query<Record<string, unknown>>(sql, [spec.keys, lo, hi]);
    if (rows.length) {
      all.push(...rows);
      console.log(`[odds]   ${m} ${lo}: ${rows.length}`);
    }
  }
  console.log(`[odds] ${m}: ${all.length} candidates in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await writeCsv(`harness/uplift/data/odds_${m}.csv`, all);
}
await closePool();
