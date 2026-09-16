#!/usr/bin/env node
// D-389a SHIP 1 static verify — does the query gate now exclude pushes?
//
// We can't introspect the deployed query directly. But we CAN replicate the
// new query string against the live REST API and check that:
//  (a) the push rows (hit=null + resolved_at NOT NULL) are excluded
//  (b) the previously-counted 10,259 unresolved drops to "10,259 - 139 pushes"
//      (or similar) — the residual is the true never-resolved set

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const envLocal = readFileSync(resolve(projectRoot, ".env.local"), "utf8");
const SUPABASE_URL = envLocal.match(/VITE_SUPABASE_URL=["']?([^"'\n]+)/)[1];
const SERVICE_ROLE = envLocal.match(/SUPABASE_SERVICE_ROLE_KEY=["']?([^"'\n]+)/)[1];
const H = { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` };

async function head(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { ...H, Prefer: "count=exact", Range: "0-0" } });
  return { count: res.headers.get("content-range"), status: res.status };
}
function n(c) { return c ? parseInt(c.split("/").pop(), 10) : null; }

async function main() {
  const cutoff = new Date(Date.now() - 14 * 86400 * 1000).toISOString().slice(0, 10);

  // (1) OLD gate: hit=is.null + voided=neq.true
  console.log("=== Old query gate (hit=null + voided!=true) — what the OLD function selected ===");
  const oldGate = await head(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=neq.true&game_date=gte.${cutoff}&select=id`);
  console.log(`  count: ${n(oldGate.count)}`);

  // (2) NEW gate: hit=is.null + voided!=true + resolved_at=is.null
  console.log("\n=== NEW query gate (hit=null + voided!=true + resolved_at=null) — what the NEW function selects ===");
  const newGate = await head(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=neq.true&resolved_at=is.null&game_date=gte.${cutoff}&select=id`);
  console.log(`  count: ${n(newGate.count)}`);

  // (3) The difference = pushes excluded
  const diff = n(oldGate.count) - n(newGate.count);
  console.log(`\n=== Differential: pushes excluded by the new gate ===`);
  console.log(`  old − new = ${diff}`);
  console.log(`  (should match the 139 PUSH count from D-388 SHIP 1 probe section 10)`);

  // (4) Specifically confirm that ALL rows in (old gate − new gate) have resolved_at NOT NULL
  console.log("\n=== Sanity: rows in (old) but NOT in (new) should have resolved_at NOT NULL ===");
  const excludedSample = await fetch(`${SUPABASE_URL}/rest/v1/pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=neq.true&resolved_at=not.is.null&game_date=gte.${cutoff}&select=id,player_name,prop_type,pick_side,line,actual_value,resolved_at,hit&order=created_at.asc&limit=10`, { headers: H });
  if (excludedSample.ok) {
    const rows = await excludedSample.json();
    console.log(`  sample of 10 rows the new gate now excludes:`);
    for (const r of rows) {
      console.log(`    ${r.player_name} ${r.prop_type} ${r.pick_side} line=${r.line} actual=${r.actual_value} hit=${r.hit} resolved_at=${r.resolved_at?.slice(0, 19)}`);
    }
  }

  // (5) New-gate queue head — confirm the head is no longer dominated by 5/18 pushes
  console.log("\n=== NEW gate queue head: oldest 10 still-unresolved ===");
  const newHead = await fetch(`${SUPABASE_URL}/rest/v1/pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=neq.true&resolved_at=is.null&game_date=gte.${cutoff}&select=id,player_name,prop_type,pick_side,line,game_date,created_at&order=created_at.asc&limit=10`, { headers: H });
  if (newHead.ok) {
    const rows = await newHead.json();
    for (const r of rows) {
      console.log(`    ${r.created_at.slice(0, 19)}  gd=${r.game_date}  ${r.player_name}  ${r.prop_type}/${r.pick_side}/${r.line}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
