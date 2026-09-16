#!/usr/bin/env node
// D-758 — pre-build/pre-deploy guard. Asserts every top-level field that the
// edge function writes to a pick_history payload has a matching column in the
// LATEST `upsert_pick_history` RPC's INSERT INTO (...) clause. If a payload
// field isn't in the INSERT list, the RPC silently drops it at the SQL
// boundary — the D-742 bug class that hid for ~12 days until D-756 surfaced
// it (scoring_inputs was written by every pitcher pick but the RPC's INSERT
// VALUES omitted it).
//
// METHOD (no DB, no network):
// 1. Find the latest `upsert_pick_history` migration (highest-numbered).
//    Extract every column name from the INSERT INTO public.pick_history (...)
//    clause via balanced-paren parsing.
// 2. Scan process-games-mlb/index.ts for the writer's payload top-level keys:
//      - `hist_payload: { ... }` object literals (Phase B push sites)
//      - `histPayload.X = ...` mutations (Phase B / Phase A patches)
//      - return literals of `batterHistPayload` + `gameHistPayload` helper fns
//    Brace-counting separates each block from its nested children (e.g.
//    nested `breakdown: { ... }`) so we only flag TOP-LEVEL payload keys.
// 3. Any payload top-level key not present in the RPC INSERT list is flagged.
//    Nested keys inside `breakdown` are intentionally skipped (breakdown is
//    the JSONB blob; its inner fields go via jsonb_populate_record without
//    needing a column each).
//
// USAGE:
//   node scripts/check_payload_to_rpc.cjs    (run from repo root)
//   npm run check:payload-rpc                (alias)
//
// Wired into the npm build chain (package.json) between the D-755 weights
// guard and tsc. The && chain halts the build before tsc/vite if any payload
// field is missing from the RPC.

const fs = require("node:fs");
const path = require("node:path");

const REPO = path.dirname(__dirname);
const MIG_DIR = path.join(REPO, "supabase/migrations");
const PGMLB_PATH = path.join(REPO, "supabase/functions/process-games-mlb/index.ts");

// 1) Find the LATEST migration that defines upsert_pick_history. We don't
// rely on filename patterns (which proved fragile — D-758's filename was
// "close_rpc_factor_column_gap", not matching "upsert*pick_history"). Instead
// we read every .sql migration and pick the alphabetically-latest one whose
// body contains "CREATE OR REPLACE FUNCTION public.upsert_pick_history".
const allMigs = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
let latestRpcFile = null;
let rpcText = null;
for (let i = allMigs.length - 1; i >= 0; i--) {
  const candidate = fs.readFileSync(path.join(MIG_DIR, allMigs[i]), "utf8");
  if (/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.upsert_pick_history/.test(candidate)) {
    latestRpcFile = allMigs[i];
    rpcText = candidate;
    break;
  }
}
if (!latestRpcFile) {
  console.error("[D-758] FAIL: no migration defines upsert_pick_history (searched all *.sql under supabase/migrations/)");
  process.exit(2);
}

// Extract the INSERT INTO public.pick_history ( ... ) clause using balanced
// paren matching. Then split by commas, strip SQL comments + whitespace, and
// build the column set.
const insertIdx = rpcText.search(/INSERT\s+INTO\s+public\.pick_history\s*\(/i);
if (insertIdx < 0) {
  console.error(`[D-758] FAIL: ${latestRpcFile} doesn't contain "INSERT INTO public.pick_history (..."`);
  process.exit(2);
}
const openParen = rpcText.indexOf("(", insertIdx);
let depth = 1;
let k = openParen + 1;
while (k < rpcText.length && depth > 0) {
  if (rpcText[k] === "(") depth++;
  else if (rpcText[k] === ")") depth--;
  k++;
}
const insertColsRaw = rpcText.slice(openParen + 1, k - 1);
const insertCols = new Set(
  insertColsRaw
    .split(",")
    .map((s) => s.replace(/--.*$/gm, "").trim())
    .filter(Boolean),
);

// 2) Scan process-games-mlb for payload top-level keys.
const src = fs.readFileSync(PGMLB_PATH, "utf8");

// 2a) `hist_payload: { ... }` blocks (Phase B push sites). Brace-counting to
// find each block's body. We grab top-level `keyname:` lines only — nested
// `breakdown: { ... }` keys are inside their own brace level and are skipped.
function findBlocks(src, markerRe) {
  // markerRe MUST end at the `{` itself (e.g. /hist_payload\s*:\s*\{/g) so
  // shorthand references like `hist_payload: histPayload` (where the value is
  // an identifier, not a literal) don't false-positively pull in some later
  // unrelated `{` block. The early version of this regex matched on `:` alone
  // and brace-counted past identifier shorthand into adjacent type interfaces
  // (StalenessEntry { ts; sonnetPending }) — flagging `ts` and `sonnetPending`
  // as silent-drops when they were just unrelated TypeScript fields.
  const blocks = [];
  let i = 0;
  while (true) {
    const m = markerRe.exec(src.slice(i));
    if (!m) break;
    // m[0] is the matched marker; its end position is the `{`. We move past it.
    const matchStart = i + m.index;
    const matchEnd = matchStart + m[0].length; // points one past `{`
    const open = matchEnd - 1; // position OF `{`
    let d = 1, c = open + 1;
    while (c < src.length && d > 0) {
      if (src[c] === "{") d++;
      else if (src[c] === "}") d--;
      c++;
    }
    blocks.push({ body: src.slice(open + 1, c - 1), end: c });
    i = c;
  }
  return blocks;
}

function topLevelKeys(blockBody) {
  // Walk char-by-char; at depth 0 (after the outer `{`), any `keyname:` is a
  // top-level key. We use brace+bracket+paren depth tracking so a `:` inside
  // a nested literal doesn't false-positive.
  const keys = new Set();
  let d = 0;
  let lineStart = 0;
  const lines = blockBody.split("\n");
  for (const rawLine of lines) {
    const line = rawLine;
    // Top-level keys: lines whose first non-whitespace token is `\w+\s*:`
    // BUT only when the line begins at depth 0.
    if (d === 0) {
      const m = line.trim().replace(/\/\/.*$/, "").match(/^(\w+)\s*:/);
      if (m) keys.add(m[1]);
    }
    // Update depth based on this line's net brace/bracket/paren delta.
    // We ignore string literals (simple heuristic — comments stripped above).
    let inStr = false;
    let strCh = "";
    for (const ch of line) {
      if (inStr) {
        if (ch === strCh) inStr = false;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { inStr = true; strCh = ch; continue; }
      if (ch === "{" || ch === "[" || ch === "(") d++;
      else if (ch === "}" || ch === "]" || ch === ")") d--;
    }
    lineStart += line.length + 1;
  }
  return keys;
}

const payloadKeys = new Set();

// 2a) hist_payload: { ... } object literals (Phase B push sites).
// Marker REQUIRES the opening `{` so shorthand `hist_payload: histPayload`
// doesn't false-positively pull a later unrelated block.
for (const blk of findBlocks(src, /hist_payload\s*:\s*\{/g)) {
  for (const k of topLevelKeys(blk.body)) payloadKeys.add(k);
}

// 2b) histPayload.X = ... mutations. Anywhere in the file.
for (const m of src.matchAll(/histPayload\.(\w+)\s*=/g)) {
  payloadKeys.add(m[1]);
}

// 2c) Return literals of helper functions that build hist_payload objects.
function returnLiteralKeys(funcName) {
  const fnIdx = src.indexOf(`function ${funcName}`);
  if (fnIdx < 0) return new Set();
  // Find the function body via brace counting from the next `{`.
  const open = src.indexOf("{", fnIdx);
  if (open < 0) return new Set();
  let d = 1, c = open + 1;
  while (c < src.length && d > 0) {
    if (src[c] === "{") d++;
    else if (src[c] === "}") d--;
    c++;
  }
  const body = src.slice(open + 1, c - 1);
  // Find `return {` inside the body. Use brace counting on the object.
  const ret = body.indexOf("return {");
  if (ret < 0) return new Set();
  const objOpen = body.indexOf("{", ret);
  let dd = 1, kk = objOpen + 1;
  while (kk < body.length && dd > 0) {
    if (body[kk] === "{") dd++;
    else if (body[kk] === "}") dd--;
    kk++;
  }
  return topLevelKeys(body.slice(objOpen + 1, kk - 1));
}
for (const k of returnLiteralKeys("batterHistPayload")) payloadKeys.add(k);
for (const k of returnLiteralKeys("gameHistPayload")) payloadKeys.add(k);

// 3) Compare. A payload top-level key not present in the RPC INSERT list is a
// silent-drop risk.
//
// Known intentionally-not-persisted runtime keys (computed downstream, not
// columns): NONE today. We treat every top-level hist_payload field as needing
// a corresponding INSERT column — that's the whole point of D-756's catch.
const missing = [];
for (const k of payloadKeys) {
  if (!insertCols.has(k)) missing.push(k);
}

if (missing.length === 0) {
  // Silent pass on happy path.
  process.exit(0);
}

console.error(`[D-758] FAIL: ${missing.length} payload field(s) missing from ${latestRpcFile} INSERT INTO list.`);
console.error("The edge function writes these keys to the pick_history payload, but the RPC's explicit INSERT column list omits them.");
console.error("The RPC's jsonb_populate_record loads them into the rec, but the INSERT VALUES tuple writes nothing for them → column stays NULL.");
console.error("This is the D-742 silent-drop bug class (closed by D-756 / D-758).");
for (const m of missing) {
  console.error(`  - ${m}    ← add to INSERT column list + VALUES tuple in ${latestRpcFile}, with a matching DO UPDATE SET ${m} = COALESCE(EXCLUDED.${m}, pick_history.${m})`);
}
process.exit(1);
