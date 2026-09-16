#!/usr/bin/env node
// D-755 — pre-build/pre-deploy guard. Asserts every DEFAULT_W{,_BATTER,_GAME}
// key is wired in mlb_weights.ts loader.
//
// Why this script exists: TypeScript's type system would catch this if the
// loader's return type were inferred strictly enough, but the codebase has a
// ~60+ baseline TS-2322 noise that has historically masked new errors. This
// standalone check has ZERO baseline noise — any failure is a real
// missing-wire bug worth blocking on.
//
// Runs deterministically (no DB, no network): parses DEFAULT_W{,_BATTER,_GAME}
// from scoring_mlb_v2.ts and the loader's num()-wired keys from mlb_weights.ts,
// compares the two key-sets. Exits 1 + prints missing keys if any are
// unwired; exits 0 silently if all keys match.
//
// Usage (run from repo root):
//   node scripts/check_weights_wired.js
//   or via the wrapper: ./scripts/check_weights_wired.js
//
// Wire-into-build: package.json adds it as a `prebuild` script so
// `npm run build` runs it before tsc+vite. CI runs the same npm build.
//
// Companion: the runtime guard in setMlbWeights{,WithPerMarket}
// (scoring_mlb_v2.ts, D-755) is the ALWAYS-ON enforcement that fires on
// every cron tick post-deploy. This script is the BEFORE-DEPLOY catch so
// you don't ship the bug at all.

const fs = require("node:fs");
const path = require("node:path");

const REPO = path.dirname(__dirname);
const SCORING = fs.readFileSync(path.join(REPO, "supabase/functions/_shared/scoring_mlb_v2.ts"), "utf8");
const LOADER  = fs.readFileSync(path.join(REPO, "supabase/functions/_shared/mlb_weights.ts"), "utf8");

function extractDefaultKeys(name) {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*\\{([\\s\\S]*?)\\}\\s*as\\s+const`, "m");
  const m = SCORING.match(re);
  if (!m) {
    throw new Error(`[D-755] could not locate ${name} in scoring_mlb_v2.ts — has the file structure changed?`);
  }
  const body = m[1];
  const keys = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.length === 0) continue;
    const kv = trimmed.match(/^(\w+)\s*:\s*-?[\d.]+/);
    if (kv) keys.push(kv[1]);
  }
  return keys;
}

function extractLoaderKeys() {
  // Any `keyname: num(` line. A key wired anywhere in the loader is read at runtime.
  const keys = new Set();
  for (const line of LOADER.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.length === 0) continue;
    const kv = trimmed.match(/^(\w+)\s*:\s*num\(/);
    if (kv) keys.add(kv[1]);
  }
  return keys;
}

const wKeys  = extractDefaultKeys("DEFAULT_W");
const wbKeys = extractDefaultKeys("DEFAULT_W_BATTER");
const wgKeys = extractDefaultKeys("DEFAULT_W_GAME");
const loaderKeys = extractLoaderKeys();

const missing = [];
for (const k of wKeys)  if (!loaderKeys.has(k)) missing.push({ block: "DEFAULT_W",        key: k });
for (const k of wbKeys) if (!loaderKeys.has(k)) missing.push({ block: "DEFAULT_W_BATTER", key: k });
for (const k of wgKeys) if (!loaderKeys.has(k)) missing.push({ block: "DEFAULT_W_GAME",   key: k });

if (missing.length === 0) {
  // Silent pass on the happy path so it doesn't add noise to every build.
  process.exit(0);
}

console.error(`[D-755] FAIL: ${missing.length} DEFAULT_W key(s) missing from mlb_weights.ts loader.`);
console.error("Each unwired key becomes undefined at runtime → NaN cascade → silent default (calibration ceiling). See D-749 + D-753 for the bug class.");
for (const m of missing) {
  const fallbackPrefix = m.block === "DEFAULT_W" ? "W" : m.block.replace("DEFAULT_", "");
  console.error(`  - ${m.block}.${m.key}    ← add to mlb_weights.ts as:  ${m.key}: num(w.w_mlb_<col>, fallback.${fallbackPrefix}.${m.key}),`);
}
process.exit(1);
