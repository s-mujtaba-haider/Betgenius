#!/usr/bin/env node
// D-353 verification — confirm Dashboard.tsx:445 readOnly guard stops the
// auto-mount get-live-games call for non-admin users.

import puppeteer from "puppeteer";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const SESSION_FILE = resolve(projectRoot, ".puppeteer", "session.json");
const SHOTS_DIR = resolve(projectRoot, ".puppeteer", "screenshots", "d353");
const BASE_URL = "https://betgenius-eight.vercel.app";

mkdirSync(SHOTS_DIR, { recursive: true });
const session = JSON.parse(readFileSync(SESSION_FILE, "utf8"));

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

const out = { suspect_calls: [], get_live_games_calls: 0, dashboard_buttons: {} };

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  // Track every edge-function call so we can pinpoint get-live-games specifically.
  page.on("request", (req) => {
    const u = req.url();
    if (/\/functions\/v1\//.test(u)) {
      out.suspect_calls.push({ method: req.method(), url: u.split("?")[0] });
      if (u.includes("get-live-games")) out.get_live_games_calls++;
    }
  });

  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.evaluate((ls) => {
    for (const [k, v] of Object.entries(ls)) window.localStorage.setItem(k, v);
    // Force MLB selection (where Dashboard has actual data to render)
    window.localStorage.setItem("betgenius_user_sport", "mlb");
  }, session.localStorage);

  // Reset call log AFTER localStorage seed (avoid counting auth-prefetch noise).
  out.suspect_calls = [];
  out.get_live_games_calls = 0;

  await page.reload({ waitUntil: "networkidle2", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 10000));  // long wait — catch any deferred mount-time call

  // Read user email + confirm session loaded
  const userInfo = await page.evaluate(() => {
    const raw = window.localStorage.getItem("sb-gzuzuqxvfjszlfclhcfz-auth-token");
    const cs = JSON.parse(raw).currentSession || JSON.parse(raw);
    return { email: cs.user?.email, expires_at: cs.expires_at };
  });
  out.session = userInfo;

  // Confirm Dashboard rendered as non-admin (gated buttons present)
  const dashState = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll("button"));
    return {
      total_buttons: all.length,
      disabled_with_preview_tooltip: all.filter((b) => b.disabled && (b.getAttribute("title") || "").includes("Preview mode")).length,
      refresh_button: (() => {
        const r = all.find((b) => (b.innerText || "").trim() === "Refresh");
        return r ? { disabled: r.disabled, title: r.getAttribute("title") } : null;
      })(),
    };
  });
  out.dashboard_buttons = dashState;

  await page.screenshot({ path: resolve(SHOTS_DIR, "dashboard_post_d353.png"), fullPage: true });
  writeFileSync(resolve(SHOTS_DIR, "results.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
} finally {
  await browser.close();
}
