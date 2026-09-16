#!/usr/bin/env node
// One-shot capture: open a magic-link URL directly in puppeteer + save cookies.
// Used when the interactive seeder flow stalls and we already have a fresh
// magic link from gmail.

import puppeteer from "puppeteer";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const PUPPETEER_DIR = resolve(projectRoot, ".puppeteer");
const SESSION_FILE = resolve(PUPPETEER_DIR, "session.json");
const AUTH_COOKIE_NAME = "sb-gzuzuqxvfjszlfclhcfz-auth-token";

const url = process.argv[2];
if (!url) {
  console.error("usage: node scripts/capture_via_magic_link.mjs <magic-link-url>");
  process.exit(1);
}

mkdirSync(PUPPETEER_DIR, { recursive: true });

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

try {
  const page = await browser.newPage();
  console.log(`[capture] navigating to magic link...`);
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  console.log(`[capture] post-nav URL: ${page.url()}`);

  // Wait for redirect chain + supabase-js to write localStorage
  await new Promise((r) => setTimeout(r, 8000));
  console.log(`[capture] final URL: ${page.url()}`);

  // Read BOTH cookies AND localStorage. Supabase-js v2 defaults to localStorage
  // for session storage, not cookies. Capture both for visual_verify compatibility.
  const cookies = await page.cookies();
  const localStorage = await page.evaluate(() => {
    const out = {};
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      out[k] = window.localStorage.getItem(k);
    }
    return out;
  });

  console.log(`[capture] cookie names: ${cookies.map(c => c.name).join(", ")}`);
  console.log(`[capture] localStorage keys: ${Object.keys(localStorage).join(", ")}`);

  const authCookie = cookies.find((c) => c.name === AUTH_COOKIE_NAME && c.value && c.value.length > 20);
  const authLs = localStorage[AUTH_COOKIE_NAME];

  if (!authCookie && !authLs) {
    console.error(`[capture] auth NOT found in cookies OR localStorage.`);
    console.error(`[capture] page title: ${await page.title()}`);
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));
    console.error(`[capture] page text excerpt: ${bodyText}`);
    process.exit(2);
  }

  // Compose enriched session file. visual_verify needs to be updated to
  // restore localStorage before navigating (cookies alone aren't enough).
  const payload = {
    version: 2,
    captured_at: new Date().toISOString(),
    cookies: cookies.map((c) => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path || "/",
      secure: c.secure ?? true, httpOnly: c.httpOnly ?? false,
      sameSite: c.sameSite ?? "Lax", expires: c.expires ?? -1,
    })),
    localStorage: localStorage,
  };
  writeFileSync(SESSION_FILE, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
  console.log(`[capture] ✓ session written → ${SESSION_FILE}`);
  console.log(`[capture]   cookies: ${payload.cookies.length}, localStorage keys: ${Object.keys(localStorage).length}`);
  console.log(`[capture]   auth source: ${authLs ? "localStorage" : "cookie"}`);
} catch (err) {
  console.error(`[capture] error: ${err.message}`);
  process.exit(3);
} finally {
  await browser.close();
}
