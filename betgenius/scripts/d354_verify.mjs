#!/usr/bin/env node
// D-354 verification — confirm new factor labels render on Dashboard (admin view)
// AND D-350/D-353 read-only gates still active for non-admin.

import puppeteer from "puppeteer";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const SESSION_FILE = resolve(projectRoot, ".puppeteer", "session.json");
const SHOTS_DIR = resolve(projectRoot, ".puppeteer", "screenshots", "d354");
const BASE_URL = "https://betgenius-eight.vercel.app";

mkdirSync(SHOTS_DIR, { recursive: true });
const session = JSON.parse(readFileSync(SESSION_FILE, "utf8"));

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

const out = { suspect_calls: [], get_live_games_calls: 0 };

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  page.on("request", (req) => {
    const u = req.url();
    if (/\/functions\/v1\/get-live-games/.test(u)) out.get_live_games_calls++;
    if (/\/functions\/v1\//.test(u)) out.suspect_calls.push({ method: req.method(), url: u.split("?")[0] });
  });

  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.evaluate((ls) => {
    for (const [k, v] of Object.entries(ls)) window.localStorage.setItem(k, v);
    window.localStorage.setItem("betgenius_user_sport", "mlb");
  }, session.localStorage);

  // Reset call log AFTER seeding (don't count auth prefetch)
  out.suspect_calls = [];
  out.get_live_games_calls = 0;

  await page.reload({ waitUntil: "networkidle2", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 10000));

  // Look for new labels on a click-expand factor row
  const labelProbe = await page.evaluate(() => {
    const bodyText = document.body.innerText;
    return {
      has_streak_label: bodyText.includes("Hitter streak fatigue"),
      has_lineup_k_label: bodyText.includes("Lineup K composition"),
      // Also confirm older labels still present (regression check)
      has_velocity_label: bodyText.includes("Pitcher velocity trend"),
      has_lineup_spot_label: bodyText.includes("Lineup batting order"),
    };
  });
  out.labels = labelProbe;

  // Confirm D-350/D-353 gates still active
  const gateProbe = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll("button"));
    return {
      total_buttons: all.length,
      disabled_with_preview_tooltip: all.filter((b) => b.disabled && (b.getAttribute("title") || "").includes("Preview mode")).length,
    };
  });
  out.gate_state = gateProbe;

  await page.screenshot({ path: resolve(SHOTS_DIR, "dashboard_post_d354.png"), fullPage: true });

  // Expand a pick card to see factor rows
  const expanded = await page.evaluate(() => {
    const showFactorsBtn = Array.from(document.querySelectorAll("button")).find((b) =>
      (b.innerText || "").includes("Show factors")
    );
    if (showFactorsBtn) {
      showFactorsBtn.click();
      return true;
    }
    return false;
  });
  if (expanded) {
    await new Promise((r) => setTimeout(r, 1500));
    await page.screenshot({ path: resolve(SHOTS_DIR, "dashboard_factors_expanded.png"), fullPage: true });
    // Re-probe text after expand
    const expandedLabels = await page.evaluate(() => {
      const t = document.body.innerText;
      return {
        has_streak_label_visible: t.includes("Hitter streak fatigue"),
        has_lineup_k_label_visible: t.includes("Lineup K composition"),
      };
    });
    out.labels_after_expand = expandedLabels;
  }

  writeFileSync(resolve(SHOTS_DIR, "results.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
} finally {
  await browser.close();
}
