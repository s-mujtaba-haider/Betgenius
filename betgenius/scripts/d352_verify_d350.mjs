#!/usr/bin/env node
// D-352 — autonomous visual verification of D-350 read-only gating.
//
// Loads .puppeteer/session.json (refreshed via admin /generate_link in D-352
// SHIP 1, valid for ~1h), navigates each gated page as the non-admin test
// account test@example.com, asserts disabled buttons + the
// "Preview mode" tooltip attribute, screenshots each page, attempts a click
// on a gated button to confirm the handler short-circuits (no API call).

import puppeteer from "puppeteer";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const PUPPETEER_DIR = resolve(projectRoot, ".puppeteer");
const SESSION_FILE = resolve(PUPPETEER_DIR, "session.json");
const SHOTS_DIR = resolve(PUPPETEER_DIR, "screenshots", "d352");
const BASE_URL = "https://betgenius-eight.vercel.app";
const TOOLTIP_TEXT = "Preview mode — full access requires subscription";

mkdirSync(SHOTS_DIR, { recursive: true });

function loadSession() {
  if (!existsSync(SESSION_FILE)) {
    console.error("✗ session file missing — run capture_via_magic_link first");
    process.exit(3);
  }
  return JSON.parse(readFileSync(SESSION_FILE, "utf8"));
}

const session = loadSession();
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

const results = {
  session: { user_email: null, expires_at: null },
  pages: {},
};

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  // Hydrate localStorage with the auth token BEFORE navigating to the SPA.
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.evaluate((ls) => {
    for (const [k, v] of Object.entries(ls)) {
      window.localStorage.setItem(k, v);
    }
  }, session.localStorage);
  // Track network: count post-D-350 expensive function calls that should NOT fire.
  const networkLog = { suspect_calls: [] };
  page.on("request", (req) => {
    const u = req.url();
    if (/\/functions\/v1\/(analyze-pick|get-live-games|process-games-mlb|fetch-odds|resolve-picks)/.test(u)) {
      networkLog.suspect_calls.push({ url: u, method: req.method() });
    }
  });

  // Hard reload after seeding localStorage so SPA picks up auth.
  await page.reload({ waitUntil: "networkidle2", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 4000));

  // Read user email from localStorage to confirm non-admin session.
  const userInfo = await page.evaluate(() => {
    const raw = window.localStorage.getItem("sb-gzuzuqxvfjszlfclhcfz-auth-token");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const cs = parsed.currentSession || parsed;
    return { email: cs.user?.email ?? null, expires_at: cs.expires_at ?? null };
  });
  results.session = userInfo ?? {};
  console.log(`[session] email=${userInfo?.email} expires_at=${userInfo?.expires_at}`);

  // Helper: navigate to a page via the nav dispatch event (App.tsx listens to bg:navigate).
  async function navTo(detail) {
    await page.evaluate((d) => window.dispatchEvent(new CustomEvent("bg:navigate", { detail: d })), detail);
    await new Promise((r) => setTimeout(r, 3500));
  }

  // For each gated page, walk a probe matrix:
  //   buttons_with_preview_tooltip: count
  //   buttons_disabled_total: count (disabled attribute on <button>)
  //   click_short_circuit: did suspect_calls remain empty after attempted click?
  async function probePage(name, navDetail, expectedGatedTitles, clickTarget) {
    networkLog.suspect_calls = [];
    if (navDetail) await navTo(navDetail);
    await new Promise((r) => setTimeout(r, 2500));

    const probe = await page.evaluate((tooltipText) => {
      const all = Array.from(document.querySelectorAll("button"));
      const total = all.length;
      const disabled = all.filter((b) => b.disabled).length;
      // buttons whose title attribute === tooltipText (regardless of disabled state)
      const withTooltip = all.filter((b) => (b.getAttribute("title") || "").includes(tooltipText));
      const disabledWithTooltip = withTooltip.filter((b) => b.disabled);
      const tooltipSamples = withTooltip.slice(0, 5).map((b) => ({
        text: (b.innerText || "").trim().slice(0, 50),
        disabled: !!b.disabled,
        title: b.getAttribute("title"),
      }));
      return { total, disabled, with_tooltip_count: withTooltip.length, disabled_with_tooltip: disabledWithTooltip.length, samples: tooltipSamples };
    }, TOOLTIP_TEXT);

    const shot = resolve(SHOTS_DIR, `${name}.png`);
    await page.screenshot({ path: shot, fullPage: true });

    // Attempt click on the first gated button and confirm no suspect network call fires.
    let click_short_circuit = "n/a";
    if (clickTarget) {
      const before = networkLog.suspect_calls.length;
      const clicked = await page.evaluate((selectorOrText, tooltipText) => {
        const all = Array.from(document.querySelectorAll("button"));
        const target = all.find((b) =>
          (b.innerText || "").trim() === selectorOrText
          || ((b.getAttribute("title") || "").includes(tooltipText) && (b.innerText || "").trim().includes(selectorOrText))
        );
        if (!target) return false;
        target.click();
        return true;
      }, clickTarget, TOOLTIP_TEXT);
      // Wait a bit for any leaked request to land
      await new Promise((r) => setTimeout(r, 2500));
      const after = networkLog.suspect_calls.length;
      click_short_circuit = clicked ? (after === before ? "YES" : `NO (${after - before} suspect calls)`) : "no_target_found";
    }

    results.pages[name] = {
      ...probe,
      screenshot: shot,
      click_short_circuit,
      suspect_calls_after: [...networkLog.suspect_calls],
    };
    console.log(`[${name}] disabled=${probe.disabled}/${probe.total} with_tooltip=${probe.with_tooltip_count} disabled+tooltip=${probe.disabled_with_tooltip} click_short_circuit=${click_short_circuit}`);
  }

  await probePage("dashboard", "dashboard", null, "Log Bet");
  await probePage("games", "games", null, "Log Bet");
  await probePage("evaluator", "evaluator", null, null);
  await probePage("tracker", "tracker", null, null);

  // HARMLESS: verify sport toggle works (NBA → MLB → NBA) on dashboard
  await navTo("dashboard");
  await new Promise((r) => setTimeout(r, 2000));
  const sportToggle = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    const nba = btns.find((b) => (b.innerText || "").trim() === "NBA");
    const mlb = btns.find((b) => (b.innerText || "").trim() === "MLB");
    return {
      nba_disabled: nba?.disabled ?? null,
      mlb_disabled: mlb?.disabled ?? null,
      nba_text: nba?.innerText,
      mlb_text: mlb?.innerText,
    };
  });
  results.sport_toggle = sportToggle;
  console.log(`[sport-toggle] nba.disabled=${sportToggle.nba_disabled} mlb.disabled=${sportToggle.mlb_disabled}`);

  // Also click MLB and confirm no suspect calls + UI navigates without error
  networkLog.suspect_calls = [];
  const clickedMlb = await page.evaluate(() => {
    const mlb = Array.from(document.querySelectorAll("button")).find((b) => (b.innerText || "").trim() === "MLB");
    if (!mlb) return false;
    mlb.click();
    return true;
  });
  await new Promise((r) => setTimeout(r, 3500));
  results.sport_toggle.click_worked = clickedMlb;
  results.sport_toggle.suspect_calls_after_click = networkLog.suspect_calls.length;
  await page.screenshot({ path: resolve(SHOTS_DIR, "dashboard_mlb_after_toggle.png"), fullPage: true });
  console.log(`[sport-toggle] clicked_mlb=${clickedMlb} suspect_calls=${networkLog.suspect_calls.length}`);

  // Final summary write
  writeFileSync(resolve(SHOTS_DIR, "results.json"), JSON.stringify(results, null, 2));
  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
