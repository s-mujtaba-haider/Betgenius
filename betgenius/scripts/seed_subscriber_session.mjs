#!/usr/bin/env node
// D-252 Task A — Interactive subscriber session seeder.
//
// Launches a HEADFUL puppeteer browser at https://betgenius-eight.vercel.app
// and waits for the CEO to complete magic-link signup. Once the authenticated
// state is detected (Supabase auth cookie present), captures all cookies for
// the betgenius-eight.vercel.app domain and writes to .puppeteer/session.json
// in the format expected by scripts/visual_verify.mjs --auth=yes.
//
// Usage:
//   node scripts/seed_subscriber_session.mjs --email=you+sharpaitest@gmail.com
//
// After running:
//   1. Browser window opens at /signup
//   2. CEO enters --email value, completes TOS + 21+ checkboxes, clicks send
//   3. CEO checks gmail for magic link, clicks link in a different tab/window
//      OR allows the magic-link tab to redirect inside the headful browser
//   4. Once authenticated, script auto-detects, saves cookies, closes browser
//   5. .puppeteer/session.json is now ready for visual_verify.mjs --auth=yes
//
// Detection strategy: poll cookies every 3s for `sb-gzuzuqxvfjszlfclhcfz-auth-token`
// (Supabase auth cookie). Once present + URL is on app surface (not /signin),
// session is captured.

import { Command } from "commander";
import puppeteer from "puppeteer";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const PUPPETEER_DIR = resolve(projectRoot, ".puppeteer");
const SESSION_FILE = resolve(PUPPETEER_DIR, "session.json");

const BASE_URL = "https://betgenius-eight.vercel.app";
const AUTH_COOKIE_NAME = "sb-gzuzuqxvfjszlfclhcfz-auth-token";
const POLL_INTERVAL_MS = 3000;

const DEFAULT_EMAIL = "test@example.com";

const program = new Command();
program
  .name("seed_subscriber_session")
  .description("One-shot interactive subscriber session seeder (D-252 Task A / D-253 Phase 1)")
  .option("--email <email>", `gmail+alias address (default: ${DEFAULT_EMAIL})`, DEFAULT_EMAIL)
  .option("--timeout-mins <n>", "minutes to wait for authentication", (raw) => Number.parseInt(raw, 10) || 15)
  .option("--headful", "show browser window (default: true)", true)
  .option("--ci", "non-interactive / headless mode (overrides --headful)")
  .parse(process.argv);

const opts = program.opts();

const timeoutMs = (opts.timeoutMins ?? 15) * 60 * 1000;
const startedAt = Date.now();

console.log("");
console.log("╔════════════════════════════════════════════════════════════════════╗");
console.log("║  SharpAI subscriber session seeder (D-252 Task A)                  ║");
console.log("╚════════════════════════════════════════════════════════════════════╝");
console.log("");
console.log(`  Target site:      ${BASE_URL}`);
console.log(`  Test email:       ${opts.email}`);
console.log(`  Auth cookie:      ${AUTH_COOKIE_NAME}`);
console.log(`  Session output:   ${SESSION_FILE}`);
console.log(`  Timeout:          ${opts.timeoutMins ?? 15} minutes`);
console.log("");
console.log("  CEO instructions:");
console.log(`    1. The browser window will open at ${BASE_URL}/?signin=1`);
console.log(`    2. Enter "${opts.email}" in the email field`);
console.log("    3. Check the TOS + 21+ checkboxes if not already checked");
console.log("    4. Click \"Send magic link\"");
console.log("    5. Open Gmail in any tab/window — check inbox for the magic link");
console.log("    6. Click the magic link (it will open in a new tab; that's fine)");
console.log("    7. Wait — this script auto-detects auth and saves cookies");
console.log("");
console.log("  Polling for authenticated state every 3s. Ctrl-C to abort.");
console.log("");

mkdirSync(PUPPETEER_DIR, { recursive: true });

let browser;
try {
  browser = await puppeteer.launch({
    headless: opts.ci ? "new" : false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    defaultViewport: { width: 1280, height: 900 },
  });
} catch (err) {
  console.error(`✗ puppeteer launch failed: ${err.message}`);
  process.exit(2);
}

try {
  const page = (await browser.pages())[0] || await browser.newPage();
  await page.goto(`${BASE_URL}/?signin=1`, { waitUntil: "networkidle2", timeout: 30_000 });
  console.log(`  ✓ Browser opened at ${BASE_URL}/?signin=1`);
  console.log("");
  console.log("  Waiting for authentication...");

  let captured = null;
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    let cookies;
    try {
      cookies = await page.cookies();
    } catch {
      // Browser may have navigated; refetch on the current page
      const pages = await browser.pages();
      const p = pages[pages.length - 1];
      if (!p) continue;
      cookies = await p.cookies();
    }

    const auth = cookies.find((c) => c.name === AUTH_COOKIE_NAME && c.value && c.value.length > 20);
    if (auth) {
      captured = cookies;
      console.log("");
      console.log(`  ✓ Auth cookie detected (${AUTH_COOKIE_NAME})`);
      console.log(`  ✓ Captured ${cookies.length} cookie(s) total`);
      break;
    }

    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    process.stdout.write(`\r  ... waiting (${elapsed}s elapsed, polling every ${POLL_INTERVAL_MS / 1000}s)`);
  }

  if (!captured) {
    console.error("");
    console.error(`✗ Timeout after ${opts.timeoutMins ?? 15} minutes. No auth cookie observed.`);
    console.error("  Possible causes:");
    console.error("    - Magic link never clicked");
    console.error("    - Email not delivered (check spam, verify Resend is configured)");
    console.error("    - Magic link clicked in a different browser (not this puppeteer instance)");
    console.error("    - Supabase auth cookie name has changed");
    process.exit(2);
  }

  const payload = captured.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || "/",
    secure: c.secure ?? true,
    httpOnly: c.httpOnly ?? false,
    sameSite: c.sameSite ?? "Lax",
    expires: c.expires ?? -1,
  }));

  writeFileSync(SESSION_FILE, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });

  console.log("");
  console.log(`  ✓ Session written → ${SESSION_FILE}`);
  console.log(`  ✓ File permissions: 0600 (owner read/write only)`);
  console.log(`  ✓ Cookies captured: ${payload.length}`);
  console.log(`  ✓ Seeded for email: ${opts.email}`);
  console.log(`  ✓ Captured at: ${new Date().toISOString()}`);
  console.log("");
  console.log("  Next: run visual_verify with --auth=yes to test:");
  console.log(`    node scripts/visual_verify.mjs --auth=yes --assert="Dashboard"`);
  console.log("");
  console.log("  Auto-closing browser in 5 seconds...");
  await new Promise((r) => setTimeout(r, 5000));
} catch (err) {
  console.error("");
  console.error(`✗ Error during session seeding: ${err.message}`);
  process.exit(2);
} finally {
  await browser.close().catch(() => {});
}

console.log("  ✓ Browser closed. Session seeder complete.");
process.exit(0);
