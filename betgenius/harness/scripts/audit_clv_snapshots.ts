#!/usr/bin/env -S deno run --no-check --allow-net --allow-env --allow-read
/** Quick CLV snapshot audit — reports entry vs closing timestamp overlap. */
import { closePool, getDbFromEnv } from "../lib/env.ts";
import { loadCandidateUniverse } from "../lib/candidates.ts";

const market = Deno.args[0] ?? "batter_hits";
const start = Deno.args[1] ?? "2026-04-25";
const end = Deno.args[2] ?? "2026-05-24";

const db = getDbFromEnv();
const { groups } = await loadCandidateUniverse(db, market, start, end, {
  maxGroups: 5000,
  pageFromEnd: true,
});

let sameTs = 0;
let distinctTs = 0;
let noClosing = 0;

for (const g of groups) {
  if (!g.closingSnapshotTime || !g.entrySnapshotTime) {
    noClosing++;
    continue;
  }
  if (g.entrySnapshotTime === g.closingSnapshotTime) sameTs++;
  else distinctTs++;
}

console.log(JSON.stringify({
  market,
  window: `${start}..${end}`,
  groupsSampled: groups.length,
  entryEqClosing: sameTs,
  entryNeClosing: distinctTs,
  pctDistinct: sameTs + distinctTs > 0
    ? Number(((distinctTs / (sameTs + distinctTs)) * 100).toFixed(1))
    : null,
  noClosing,
}, null, 2));

await closePool();
