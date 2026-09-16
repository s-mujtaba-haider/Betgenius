#!/usr/bin/env node
// D-352 — MLB-mode probe. Forces MLB selection (where today's slate has picks),
// then re-counts gated buttons + grabs sample text + identifies the suspect
// network calls in detail.

import puppeteer from "puppeteer";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const SESSION_FILE = resolve(projectRoot, ".puppeteer", "session.json");
const SHOTS_DIR = resolve(projectRoot, ".puppeteer", "screenshots", "d352_mlb");
const BASE_URL = "https://betgenius-eight.vercel.app";
const TOOLTIP_TEXT = "Preview mode — full access requires subscription";

mkdirSync(SHOTS_DIR, { recursive: true });
const session = JSON.parse(readFileSync(SESSION_FILE, "utf8"));

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

const out = { suspect_calls: [], pages: {} };

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  // Capture EVERY suspect call with full URL + page-context
  let currentPage = "init";
  page.on("request", (req) => {
    const u = req.url();
    if (/\/functions\/v1\/(analyze-pick|get-live-games|process-games-mlb|fetch-odds|resolve-picks)/.test(u)) {
      out.suspect_calls.push({ page: currentPage, url: u.split("?")[0], method: req.method() });
    }
  });

  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  // Seed localStorage + force sport=mlb BEFORE the SPA boots its state.
  await page.evaluate((ls) => {
    for (const [k, v] of Object.entries(ls)) window.localStorage.setItem(k, v);
    // Force MLB selection (sport.ts SPORT_KEY = "betgenius_user_sport")
    window.localStorage.setItem("betgenius_user_sport", "mlb");
  }, session.localStorage);

  currentPage = "dashboard_initial_mount";
  await page.reload({ waitUntil: "networkidle2", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 8000));  // Longer wait for picks to render

  // Read state
  const dashState = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll("button"));
    return {
      total_buttons: all.length,
      disabled_count: all.filter((b) => b.disabled).length,
      with_tooltip: all.filter((b) => (b.getAttribute("title") || "").includes("Preview mode")).length,
      all_button_labels: all.map((b) => ({
        text: (b.innerText || "").trim().slice(0, 30),
        disabled: !!b.disabled,
        has_tooltip: (b.getAttribute("title") || "").includes("Preview mode"),
      })),
      body_text_excerpt: document.body.innerText.slice(0, 600),
    };
  });
  out.pages.dashboard_mlb = dashState;
  await page.screenshot({ path: resolve(SHOTS_DIR, "dashboard_mlb.png"), fullPage: true });

  // Look for a "Log Bet" button + hover for tooltip rendering
  const hoverProbe = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    const target = btns.find((b) => (b.innerText || "").trim() === "Log Bet");
    if (!target) return { found: false };
    target.scrollIntoView({ behavior: "instant", block: "center" });
    const rect = target.getBoundingClientRect();
    return {
      found: true,
      disabled: target.disabled,
      title: target.getAttribute("title"),
      classes: target.className,
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    };
  });
  out.pages.dashboard_mlb.log_bet_button = hoverProbe;

  // If found, hover + capture tooltip screenshot
  if (hoverProbe.found) {
    const cx = hoverProbe.rect.x + hoverProbe.rect.w / 2;
    const cy = hoverProbe.rect.y + hoverProbe.rect.h / 2;
    await page.mouse.move(cx, cy);
    await new Promise((r) => setTimeout(r, 1500));
    await page.screenshot({ path: resolve(SHOTS_DIR, "dashboard_mlb_logbet_hover.png"), fullPage: false });
  }

  // Try clicking Log Bet — should be no-op for read-only (handler short-circuits)
  if (hoverProbe.found) {
    const beforeCount = out.suspect_calls.length;
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) => (b.innerText || "").trim() === "Log Bet");
      if (btn) btn.click();
    });
    await new Promise((r) => setTimeout(r, 2000));
    const afterCount = out.suspect_calls.length;
    out.pages.dashboard_mlb.click_short_circuit_log_bet = afterCount === beforeCount ? "YES" : `NO (+${afterCount - beforeCount} suspect calls)`;
    // Did the stake form pop open? If readOnly is wired, handleClick should early-return.
    const stakeFormOpen = await page.evaluate(() => {
      return !!document.querySelector('input[type="number"][inputmode="decimal"]');
    });
    out.pages.dashboard_mlb.stake_form_opened = stakeFormOpen;
  }

  // Navigate Games
  currentPage = "games";
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("bg:navigate", { detail: "games" })));
  await new Promise((r) => setTimeout(r, 5000));
  const gamesState = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll("button"));
    return {
      total_buttons: all.length,
      disabled_count: all.filter((b) => b.disabled).length,
      with_tooltip: all.filter((b) => (b.getAttribute("title") || "").includes("Preview mode")).length,
      sample_disabled: all.filter((b) => b.disabled).slice(0, 5).map((b) => ({ text: (b.innerText || "").trim().slice(0, 30), title: b.getAttribute("title") })),
    };
  });
  out.pages.games_mlb = gamesState;
  await page.screenshot({ path: resolve(SHOTS_DIR, "games_mlb.png"), fullPage: true });

  // Navigate Evaluator
  currentPage = "evaluator";
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("bg:navigate", { detail: "evaluator" })));
  await new Promise((r) => setTimeout(r, 3000));
  const evalState = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll("button"));
    return {
      total_buttons: all.length,
      disabled_count: all.filter((b) => b.disabled).length,
      with_tooltip: all.filter((b) => (b.getAttribute("title") || "").includes("Preview mode")).length,
      sample_disabled: all.filter((b) => b.disabled).map((b) => ({ text: (b.innerText || "").trim().slice(0, 30), title: b.getAttribute("title") })),
    };
  });
  out.pages.evaluator = evalState;
  await page.screenshot({ path: resolve(SHOTS_DIR, "evaluator.png"), fullPage: true });

  // Navigate Tracker
  currentPage = "tracker";
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("bg:navigate", { detail: "tracker" })));
  await new Promise((r) => setTimeout(r, 3000));
  const trackerState = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll("button"));
    return {
      total_buttons: all.length,
      disabled_count: all.filter((b) => b.disabled).length,
      with_tooltip: all.filter((b) => (b.getAttribute("title") || "").includes("Preview mode")).length,
      sample_disabled: all.filter((b) => b.disabled).map((b) => ({ text: (b.innerText || "").trim().slice(0, 30), title: b.getAttribute("title") })),
    };
  });
  out.pages.tracker = trackerState;
  await page.screenshot({ path: resolve(SHOTS_DIR, "tracker.png"), fullPage: true });

  writeFileSync(resolve(SHOTS_DIR, "results.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
} finally {
  await browser.close();
}
