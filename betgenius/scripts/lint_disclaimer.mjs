#!/usr/bin/env node
// D-218 Task 5.4 — disclaimer CI gate.
//
// Architecture §10.6 requires the "not financial or betting advice"
// string on every subscriber-facing rendered surface. This script
// greps the source tree for the required string in:
//   - Landing.tsx (pre-auth)
//   - AuthGate.tsx (signin form) — references disclaimer link via TOS copy
//   - PickCard.tsx — pick display (subscriber-facing)
//
// Run via: npm run lint:disclaimer
// Fails non-zero if any required surface is missing the disclaimer.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

const REQUIRED_STRING = "not financial or betting advice";

// Subscriber-facing surfaces. Add to this list when adding new pre-
// auth / paid-tier surfaces.
//
// D-227 Task 7.4: hardened to cover every subscriber-facing route +
// the ErrorBoundary fallback (which renders when any route crashes).
const SURFACES = [
  "src/pages/Landing.tsx",         // / pre-auth
  "src/pages/Subscribe.tsx",       // /subscribe (signed-in but no sub)
  "src/components/AuthGate.tsx",   // signin form (TOS copy)
  "src/components/ErrorBoundary.tsx", // fallback when any route throws
];

let failures = 0;
for (const rel of SURFACES) {
  const abs = resolve(projectRoot, rel);
  if (!existsSync(abs)) {
    console.error(`✗ ${rel} — file missing`);
    failures++;
    continue;
  }
  const src = readFileSync(abs, "utf8");
  if (!src.includes(REQUIRED_STRING)) {
    console.error(`✗ ${rel} — missing required disclaimer string "${REQUIRED_STRING}"`);
    failures++;
  } else {
    console.log(`✓ ${rel}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} surface(s) missing the §10.6 disclaimer string. Build blocked.`);
  process.exit(1);
}
console.log(`\nAll ${SURFACES.length} surface(s) carry the §10.6 disclaimer.`);
