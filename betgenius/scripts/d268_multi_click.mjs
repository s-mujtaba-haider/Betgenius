#!/usr/bin/env node
// D-268 multi-click capture: All Picks toggle, Tomorrow toggle, pick-detail modal.
// Usage:
//   node /tmp/d268_multi_click.mjs --scenario=<name> --viewport=<wxh>
//
// Scenarios:
//   nba_all_picks         — Dashboard NBA → click All Picks tab
//   mlb_all_picks         — Dashboard MLB → click All Picks tab
//   nba_tomorrow          — Dashboard NBA → click Tomorrow
//   mlb_tomorrow          — Dashboard MLB → click Tomorrow
//   nba_pick_modal        — Dashboard NBA → click first pick (open modal)
//   mlb_pick_modal        — Dashboard MLB → click first pick (open modal)
//   games_mlb             — Games tab → click MLB sport toggle
//   games_nba             — Games tab → click NBA sport toggle
//   perf_mlb              — Performance tab → click MLB sport toggle

import puppeteer from "puppeteer";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = "/Users/redacted/Desktop/betting-deploy/betgenius";
const SESSION_FILE = `${projectRoot}/.puppeteer/session.json`;
const BASE_URL = "https://betgenius-eight.vercel.app";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, "").split("=");
    return [k, rest.join("=")];
  })
);

const scenario = args.scenario;
const viewportSpec = args.viewport ?? "1280x900";
const screenshot = args.screenshot;
const dom = args.dom;
const [vw, vh] = viewportSpec.split("x").map(Number);

const session = JSON.parse(readFileSync(SESSION_FILE, "utf8"));

function ensureDir(p) { mkdirSync(dirname(p), { recursive: true }); }

async function clickByText(page, text) {
  return await page.evaluate((label) => {
    const btns = Array.from(document.querySelectorAll("button"));
    const match = btns.find((b) => b.textContent?.trim() === label);
    if (match) { match.click(); return true; }
    return false;
  }, text);
}

async function clickByPrefix(page, prefix) {
  return await page.evaluate((p) => {
    const btns = Array.from(document.querySelectorAll("button"));
    const match = btns.find((b) => b.textContent?.trim().startsWith(p));
    if (match) { match.click(); return true; }
    return false;
  }, prefix);
}

async function clickFirstPickCard(page) {
  // There is no separate "pick detail modal" in this codebase — cards expand
  // inline via Compare books + Why this pick (algorithm factors) toggles.
  // Click both on the first card so the expanded state can be screenshotted.
  return await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    const compareBtn = btns.find((b) => /^Compare books/.test(b.textContent?.trim() ?? ""));
    const factorsBtn = btns.find((b) => /Why this pick|Algorithm Factors|Hide factors/.test(b.textContent ?? ""));
    let clicked = false;
    if (compareBtn) { compareBtn.click(); clicked = true; }
    if (factorsBtn) { factorsBtn.click(); clicked = true; }
    return { clicked, compareBtnText: compareBtn?.textContent?.slice(0, 100), factorsBtnText: factorsBtn?.textContent?.slice(0, 100) };
  });
}

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: vw, height: vh });
  page.setDefaultTimeout(30000);

  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.evaluate((kv) => {
    for (const [k, v] of Object.entries(kv)) {
      try { window.localStorage.setItem(k, v); } catch {}
    }
  }, session.localStorage);

  await page.goto(BASE_URL + "/", { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise(r => setTimeout(r, 4000));

  page.on("console", (msg) => {
    const t = msg.type();
    if (t === "error") console.log(`  [browser:error] ${msg.text().slice(0, 200)}`);
  });

  if (scenario === "nba_all_picks" || scenario === "nba_tomorrow" || scenario === "nba_pick_modal") {
    const r = await clickByText(page, "NBA");
    console.log(`  NBA toggle: ${r}`);
    await new Promise(r => setTimeout(r, 3000));
  } else if (scenario === "mlb_all_picks" || scenario === "mlb_tomorrow" || scenario === "mlb_pick_modal") {
    const r = await clickByText(page, "MLB");
    console.log(`  MLB toggle: ${r}`);
    await new Promise(r => setTimeout(r, 4000));
  } else if (scenario === "games_mlb") {
    await clickByText(page, "Games");
    await new Promise(r => setTimeout(r, 3000));
    await clickByText(page, "MLB");
    await new Promise(r => setTimeout(r, 4000));
  } else if (scenario === "games_nba") {
    await clickByText(page, "Games");
    await new Promise(r => setTimeout(r, 3000));
    await clickByText(page, "NBA");
    await new Promise(r => setTimeout(r, 3000));
  } else if (scenario === "perf_mlb") {
    await clickByText(page, "Performance");
    await new Promise(r => setTimeout(r, 4000));
    await clickByText(page, "MLB");
    await new Promise(r => setTimeout(r, 4000));
  } else if (scenario === "perf_nba") {
    await clickByText(page, "Performance");
    await new Promise(r => setTimeout(r, 4000));
    await clickByText(page, "NBA");
    await new Promise(r => setTimeout(r, 4000));
  }

  if (scenario === "nba_all_picks" || scenario === "mlb_all_picks") {
    const r = await clickByPrefix(page, "All Picks");
    console.log(`  All Picks click: ${r}`);
    await new Promise(r => setTimeout(r, 3000));
  }

  if (scenario === "nba_tomorrow" || scenario === "mlb_tomorrow") {
    const r = await clickByText(page, "Tomorrow");
    console.log(`  Tomorrow click: ${r}`);
    await new Promise(r => setTimeout(r, 5000));
  }

  if (scenario === "nba_pick_modal" || scenario === "mlb_pick_modal") {
    const r = await clickFirstPickCard(page);
    console.log(`  Pick click: ${JSON.stringify(r).slice(0, 300)}`);
    await new Promise(r => setTimeout(r, 3000));
  }

  const innerText = await page.evaluate(() => document.body.innerText);
  const outerHTML = await page.content();

  if (dom) {
    ensureDir(dom);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(dom, `<!-- scenario: ${scenario} -->\n<!-- innerText -->\n${innerText}\n<!-- /innerText -->\n${outerHTML}`);
    console.log(`  DOM → ${dom}`);
  }
  if (screenshot) {
    ensureDir(screenshot);
    await page.screenshot({ path: screenshot, fullPage: true });
    console.log(`  Screenshot → ${screenshot}`);
  }

  process.exit(0);
} catch (e) {
  console.error("✗ error:", e.message);
  process.exit(2);
} finally {
  await browser.close().catch(() => {});
}
