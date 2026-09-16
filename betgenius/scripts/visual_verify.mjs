#!/usr/bin/env node
// D-240 Fix 1 — Visual verification CLI.
//
// Headless browser (puppeteer) -> navigates to a SharpAI route -> waits for
// content to render -> captures screenshot + serialized DOM -> asserts that
// specified strings appear (or do NOT appear). Non-zero exit on assertion
// failure so it can gate CI / pre-flight checks.
//
// Cardinal Rule §1.18 (added in D-240 Fix 2) requires this tool to be the
// gold standard for verifying that a code change actually surfaces in the
// rendered UI. Self-grading "looks correct in source" is no longer enough.
//
// Usage examples:
//
//   node scripts/visual_verify.mjs \
//     --sport=mlb \
//     --assert="Kyle Schwarber" \
//     --not="L5: N/A, Season: N/A, L10: N/A" \
//     --screenshot=/tmp/d240_smoke.png
//
//   node scripts/visual_verify.mjs \
//     --url=https://betgenius-eight.vercel.app \
//     --tab=Dashboard \
//     --wait-for=".pick-card" \
//     --assert="70+" \
//     --dom=/tmp/dom_dump.html
//
// Exit codes:
//   0 — all assertions passed
//   1 — assertion failure (one or more --assert missing, or one or more --not present)
//   2 — navigation / setup error (puppeteer launch, network, timeout)
//   3 — auth required but no session available
//
// Auth modes:
//   --auth=no            (default) — no auth attempted; for public surfaces
//   --auth=yes           — load .puppeteer/session.json cookies before nav
//                            errors with exit 3 if file missing or unusable

import { Command } from "commander";
import puppeteer from "puppeteer";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const PUPPETEER_DIR = resolve(projectRoot, ".puppeteer");
const SESSION_FILE = resolve(PUPPETEER_DIR, "session.json");

const DEFAULT_BASE_URL = "https://betgenius-eight.vercel.app";

const program = new Command();
program
  .name("visual_verify")
  .description("Headless browser verification for SharpAI rendered surfaces (D-240)")
  .option("--url <url>", "explicit full URL to navigate; overrides --base-url + --sport/--tab")
  .option("--base-url <url>", "site origin", DEFAULT_BASE_URL)
  .option("--sport <sport>", "sport tab (nba|mlb) — toggles via button click after load")
  .option("--tab <tab>", "page tab (Dashboard|Evaluator|BetTracker|Performance|Stats)", "Dashboard")
  .option("--assert <str>", "string that MUST appear in rendered DOM (repeatable)", collect, [])
  .option("--not <str>", "string that MUST NOT appear in rendered DOM (repeatable)", collect, [])
  .option("--screenshot <path>", "write full-page PNG screenshot to this path")
  .option("--dom <path>", "write rendered DOM (innerText + outerHTML) to this path")
  .option("--viewport <wxh>", "viewport size", "1280x900")
  .option("--wait-for <selector>", "CSS selector to await before assertions")
  .option("--wait-ms <ms>", "fixed delay (ms) after navigation", parseIntOr(8000))
  .option("--auth <mode>", "auth mode (no|yes)", "no")
  .option("--headful", "show browser window (debug)")
  .option("--timeout <ms>", "per-step timeout", parseIntOr(30000))
  .parse(process.argv);

function collect(value, prev) {
  return [...prev, value];
}
function parseIntOr(fallback) {
  return (raw) => {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : fallback;
  };
}

const opts = program.opts();

function buildUrl() {
  if (opts.url) return opts.url;
  return opts.baseUrl.replace(/\/$/, "") + "/";
}

function parseViewport(spec) {
  const m = /^(\d+)x(\d+)$/.exec(spec);
  if (!m) throw new Error(`invalid --viewport ${spec}, expected WIDTHxHEIGHT`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

function loadSession() {
  if (!existsSync(SESSION_FILE)) {
    console.error(`✗ --auth=yes requested but .puppeteer/session.json missing`);
    console.error(`  Run: node scripts/seed_subscriber_session.mjs (or capture_via_magic_link.mjs)`);
    process.exit(3);
  }
  try {
    const raw = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
    // v1 format: array of cookie objects (legacy)
    // v2 format: {version, cookies, localStorage, captured_at}
    if (Array.isArray(raw)) {
      return { cookies: raw, localStorage: null, version: 1 };
    }
    return { cookies: raw.cookies ?? [], localStorage: raw.localStorage ?? null, version: raw.version ?? 2 };
  } catch (err) {
    console.error(`✗ failed to parse .puppeteer/session.json: ${err.message}`);
    process.exit(3);
  }
}

function ensureDir(p) {
  mkdirSync(dirname(p), { recursive: true });
}

async function main() {
  const url = buildUrl();
  const viewport = parseViewport(opts.viewport);
  const startedAt = Date.now();

  console.log(`▶ visual_verify`);
  console.log(`  url:        ${url}`);
  console.log(`  sport:      ${opts.sport ?? "(no toggle)"}`);
  console.log(`  tab:        ${opts.tab}`);
  console.log(`  viewport:   ${viewport.width}x${viewport.height}`);
  console.log(`  auth:       ${opts.auth}`);
  console.log(`  asserts:    ${opts.assert.length} required, ${opts.not.length} forbidden`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: opts.headful ? false : "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  } catch (err) {
    console.error(`✗ puppeteer launch failed: ${err.message}`);
    process.exit(2);
  }

  let exitCode = 0;
  try {
    const page = await browser.newPage();
    await page.setViewport(viewport);
    page.setDefaultTimeout(opts.timeout);

    if (opts.auth === "yes") {
      const session = loadSession();
      if (session.cookies && session.cookies.length > 0) {
        await page.setCookie(...session.cookies);
      }
      // For localStorage-based auth (Supabase-js v2 default), we MUST navigate
      // to the app domain first to establish origin, then inject localStorage,
      // then reload. setCookie alone won't authenticate.
      if (session.localStorage) {
        await page.goto(opts.baseUrl, { waitUntil: "domcontentloaded", timeout: opts.timeout });
        await page.evaluate((kv) => {
          for (const [k, v] of Object.entries(kv)) {
            try { window.localStorage.setItem(k, v); } catch { /* ignore */ }
          }
        }, session.localStorage);
        console.log(`  ✓ loaded ${session.cookies.length} cookies + ${Object.keys(session.localStorage).length} localStorage keys (auth via localStorage)`);
      } else {
        console.log(`  ✓ loaded ${session.cookies.length} session cookies`);
      }
    }

    page.on("console", (msg) => {
      const t = msg.type();
      if (t === "error" || t === "warning") {
        console.log(`  [browser:${t}] ${msg.text().slice(0, 200)}`);
      }
    });
    page.on("pageerror", (err) => {
      console.log(`  [browser:pageerror] ${err.message.slice(0, 200)}`);
    });

    await page.goto(url, { waitUntil: "networkidle2", timeout: opts.timeout });

    if (opts.sport) {
      const sportText = opts.sport.toUpperCase();
      const clicked = await page.evaluate((label) => {
        const btns = Array.from(document.querySelectorAll("button"));
        const match = btns.find((b) => b.textContent?.trim() === label);
        if (match) { match.click(); return true; }
        return false;
      }, sportText);
      console.log(`  ${clicked ? "✓" : "·"} sport toggle ${sportText} ${clicked ? "clicked" : "not found (already active?)"}`);
    }

    if (opts.tab && opts.tab !== "Dashboard") {
      const clicked = await page.evaluate((label) => {
        const btns = Array.from(document.querySelectorAll("button"));
        const match = btns.find((b) => b.textContent?.trim() === label);
        if (match) { match.click(); return true; }
        return false;
      }, opts.tab);
      console.log(`  ${clicked ? "✓" : "·"} tab ${opts.tab} ${clicked ? "clicked" : "not found"}`);
    }

    if (opts.waitFor) {
      try {
        await page.waitForSelector(opts.waitFor, { timeout: opts.timeout });
        console.log(`  ✓ waitFor selector "${opts.waitFor}" matched`);
      } catch {
        console.log(`  ⚠ waitFor selector "${opts.waitFor}" never appeared (continuing)`);
      }
    }
    if (opts.waitMs > 0) {
      await new Promise((r) => setTimeout(r, opts.waitMs));
    }

    const innerText = await page.evaluate(() => document.body.innerText);
    const outerHTML = await page.content();

    if (opts.dom) {
      ensureDir(opts.dom);
      const payload =
        `<!-- visual_verify dump @ ${new Date().toISOString()} -->\n` +
        `<!-- URL: ${url} -->\n` +
        `<!-- ===== body.innerText ===== -->\n` +
        innerText +
        `\n<!-- ===== /body.innerText ===== -->\n` +
        `<!-- ===== document.outerHTML ===== -->\n` +
        outerHTML;
      writeFileSync(opts.dom, payload, "utf8");
      console.log(`  ✓ DOM written → ${opts.dom} (${payload.length} bytes)`);
    }

    if (opts.screenshot) {
      ensureDir(opts.screenshot);
      await page.screenshot({ path: opts.screenshot, fullPage: true });
      console.log(`  ✓ screenshot written → ${opts.screenshot}`);
    }

    const missing = [];
    for (const needle of opts.assert) {
      if (!innerText.includes(needle) && !outerHTML.includes(needle)) {
        missing.push(needle);
      }
    }
    const forbidden = [];
    for (const needle of opts.not) {
      if (innerText.includes(needle) || outerHTML.includes(needle)) {
        forbidden.push(needle);
      }
    }

    console.log("");
    console.log(`Assertion results:`);
    for (const needle of opts.assert) {
      const ok = !missing.includes(needle);
      console.log(`  ${ok ? "✓" : "✗"} assert  "${truncate(needle, 80)}"`);
    }
    for (const needle of opts.not) {
      const ok = !forbidden.includes(needle);
      console.log(`  ${ok ? "✓" : "✗"} not     "${truncate(needle, 80)}"`);
    }

    if (missing.length > 0 || forbidden.length > 0) {
      console.log("");
      if (missing.length > 0) console.log(`✗ ${missing.length} required string(s) missing`);
      if (forbidden.length > 0) console.log(`✗ ${forbidden.length} forbidden string(s) present`);
      exitCode = 1;
    } else {
      console.log("");
      console.log(`✓ all ${opts.assert.length + opts.not.length} assertion(s) passed`);
    }
  } catch (err) {
    console.error(`✗ navigation/setup error: ${err.message}`);
    exitCode = 2;
  } finally {
    await browser.close().catch(() => {});
    console.log(`  elapsed: ${Date.now() - startedAt}ms`);
  }

  process.exit(exitCode);
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

main().catch((err) => {
  console.error(`✗ fatal: ${err.stack || err.message}`);
  process.exit(2);
});
