#!/usr/bin/env node
// D-385 — diagnostic: is the breakdown column being populated on live MLB
// picks post-D-379 (deployed 2026-05-31)? If 0/600 had it, either the RPC
// drops it, the writer's `result.breakdown` is null/undefined, or the
// migration's RPC update never deployed.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const envLocal = readFileSync(resolve(projectRoot, ".env.local"), "utf8");
const SUPABASE_URL = envLocal.match(/VITE_SUPABASE_URL=["']?([^"'\n]+)/)[1];
const SERVICE_ROLE = envLocal.match(/SUPABASE_SERVICE_ROLE_KEY=["']?([^"'\n]+)/)[1];

async function get(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  // 1) Most recent MLB picks of any confidence/resolution status
  console.log("=== Q1: 10 most recent live MLB pick_history rows (any state) ===");
  const recent = await get("pick_history?sport=eq.mlb&is_synthetic=eq.false&select=id,player_name,prop_type,confidence,created_at,breakdown,hit&order=created_at.desc&limit=10");
  for (const r of recent) {
    const bk = r.breakdown ? `breakdown_keys=${Object.keys(r.breakdown).length}` : "breakdown=NULL";
    console.log(`  ${r.created_at}  conf=${r.confidence}  ${r.player_name} ${r.prop_type}  ${bk}  hit=${r.hit}`);
  }

  // 2) Same in recommendations_cache (live picks before resolution land in pick_history)
  console.log("\n=== Q2: 10 most recent MLB recommendations_cache rows ===");
  const rc = await get("recommendations_cache?sport=eq.mlb&select=player_name,prop_type,confidence,created_at,breakdown,game_date&order=created_at.desc&limit=10");
  for (const r of rc) {
    const bk = r.breakdown ? `breakdown_keys=${Object.keys(r.breakdown).length}` : "breakdown=NULL";
    console.log(`  ${r.created_at}  conf=${r.confidence}  ${r.player_name} ${r.prop_type}  ${bk}`);
  }

  // 3) Date distribution of substantive-FADE picks vs D-379 deploy date
  console.log("\n=== Q3: Date span of live MLB conf>=70 resolved picks with ai_analysis ===");
  const span = await get("pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=not.is.null&ai_analysis=not.is.null&confidence=gte.70&select=created_at&order=created_at.asc&limit=1");
  const span2 = await get("pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=not.is.null&ai_analysis=not.is.null&confidence=gte.70&select=created_at&order=created_at.desc&limit=1");
  console.log(`  Oldest: ${span[0]?.created_at}`);
  console.log(`  Newest: ${span2[0]?.created_at}`);
  console.log(`  D-379 deploy: 2026-05-31`);

  // 4) Count post-D-379 resolved picks specifically
  console.log("\n=== Q4: Post-D-379-deploy resolved picks count ===");
  const post = await fetch(`${SUPABASE_URL}/rest/v1/pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=not.is.null&ai_analysis=not.is.null&confidence=gte.70&created_at=gte.2026-05-31&select=id&order=created_at.desc`, {
    headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, Prefer: "count=exact" },
  });
  console.log(`  Count post-2026-05-31: ${post.headers.get("content-range")}`);

  // 5) Sample the actual breakdown column values for FRESH unresolved picks
  console.log("\n=== Q5: 5 freshest unresolved MLB picks — breakdown populated? ===");
  const fresh = await get("pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&ai_analysis=not.is.null&confidence=gte.70&select=id,player_name,confidence,created_at,breakdown&order=created_at.desc&limit=5");
  for (const r of fresh) {
    const bk = r.breakdown ? `${Object.keys(r.breakdown).length} keys: ${Object.keys(r.breakdown).slice(0, 5).join(",")}...` : "NULL";
    console.log(`  ${r.created_at}  conf=${r.confidence}  ${r.player_name}  breakdown=${bk}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
