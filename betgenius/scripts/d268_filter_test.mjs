#!/usr/bin/env node
// D-268 PostgREST filter test — does .not.in.() with quoted strings work?

import { readFileSync } from "node:fs";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const env = Object.fromEntries(
  envText.split("\n").filter(l => l && !l.startsWith("#"))
    .map(l => l.replace(/^export\s+/, "").split("="))
    .map(([k, ...rest]) => [k, rest.join("=").replace(/^"|"$/g, "")])
);

const SUPABASE_URL = env.VITE_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

const HEADERS = {
  apikey: SERVICE,
  Authorization: `Bearer ${SERVICE}`,
  Accept: "application/json",
  Prefer: "count=exact",
  Range: "0-0",
};

async function probe(label, query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/recommendations_cache?${query}&select=id`, { headers: HEADERS });
  const range = res.headers.get("content-range") ?? "";
  const m = /\/(\d+|\*)/.exec(range);
  console.log(`  ${label}: ${res.status} | count=${m?.[1] ?? "?"}`);
}

const today = "2026-05-19";
const sport = "mlb";

console.log(`Testing PostgREST .not.in.() filter syntax for MLB on ${today}:\n`);

// Variant 1: current code syntax (Supabase JS-style with quotes)
await probe("baseline (no filter)", `game_date=eq.${today}&sport=eq.${sport}`);
await probe("not.in with QUOTED values: '(\"spread\",\"game_total\",\"h2h\",\"spreads\",\"totals\")'",
  `game_date=eq.${today}&sport=eq.${sport}&prop_type=not.in.("spread","game_total","h2h","spreads","totals")`);
await probe("not.in with UNQUOTED values: (spread,game_total,h2h,spreads,totals)",
  `game_date=eq.${today}&sport=eq.${sport}&prop_type=not.in.(spread,game_total,h2h,spreads,totals)`);
await probe("only spreads excluded (unquoted)",
  `game_date=eq.${today}&sport=eq.${sport}&prop_type=not.in.(spreads)`);
await probe("only spreads excluded (quoted)",
  `game_date=eq.${today}&sport=eq.${sport}&prop_type=not.in.("spreads")`);

// What does supabase-js actually generate? Test the literal string with parens-wrapped
await probe("not.in with paren-quoted set",
  `game_date=eq.${today}&sport=eq.${sport}&prop_type=not.in.%28%22spread%22%2C%22game_total%22%2C%22h2h%22%2C%22spreads%22%2C%22totals%22%29`);
