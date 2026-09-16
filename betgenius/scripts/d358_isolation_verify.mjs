#!/usr/bin/env node
// D-358 SHIP 5 — synthetic isolation regression check.
//
// Two-layer test:
//   (a) Direct REST as the authenticated admin user (mirrors what
//       Performance.tsx queries). Asserts synthetic rows are filtered out.
//   (b) Puppeteer dashboard load. Asserts no synthetic player names
//       appear in the Performance DOM and the network calls don't expose
//       d358_synthetic_backfill rows.

import puppeteer from "puppeteer";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const SESSION_FILE = resolve(projectRoot, ".puppeteer", "session.json");
const SHOTS_DIR = resolve(projectRoot, ".puppeteer", "screenshots", "d358");
const REPORT_FILE = resolve(projectRoot, "docs", "loop", "reports", "d358_isolation_verify.json");
const BASE_URL = "https://betgenius-eight.vercel.app";
const SUPABASE_URL = "https://gzuzuqxvfjszlfclhcfz.supabase.co";

mkdirSync(SHOTS_DIR, { recursive: true });
mkdirSync(dirname(REPORT_FILE), { recursive: true });

const session = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
const authTokenRaw = session.localStorage["sb-gzuzuqxvfjszlfclhcfz-auth-token"];
const authParsed = JSON.parse(authTokenRaw);
const accessToken = authParsed.access_token;

// Anon key needed as apikey header alongside the user JWT
const envLocal = readFileSync(resolve(projectRoot, ".env.local"), "utf8");
const ANON = envLocal.match(/VITE_SUPABASE_ANON_KEY=["']?([^"'\n]+)/)?.[1];

const out = {
  ts: new Date().toISOString(),
  d358_backfill_run_id: "01c0fbab-a7ed-412d-a43f-45b20e0b8a7f",
  layer_a_direct_rest: {},
  layer_b_puppeteer: {},
};

// ----- Layer A: direct REST as authed user -----

async function restGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${accessToken}`,
      "Prefer": "count=exact",
      "Range": "0-9",
    },
  });
  return {
    status: res.status,
    contentRange: res.headers.get("content-range"),
    body: await res.json().catch(() => null),
  };
}

// (i) Visibility check: can authed user see synthetic rows at all?
const synthVis = await restGet(`pick_history?backfill_run_id=eq.${out.d358_backfill_run_id}&select=id,is_synthetic,source&limit=5`);
out.layer_a_direct_rest.synthetic_visible_to_admin = {
  status: synthVis.status,
  count: parseInt(synthVis.contentRange?.split("/")[1] || "0", 10),
  note: "Admins WITH the filter should see them; this confirms the rows exist + admin has RLS visibility.",
};

// (ii) Performance-tsx replica query: is_synthetic=eq.false (what Production filters)
//     The Performance page query.
const prodQuery = await restGet(`pick_history?is_synthetic=eq.false&hit=not.is.null&sport=eq.mlb&select=id,player_name,source,is_synthetic,backfill_run_id&order=created_at.desc&limit=10`);
const prodBodyArr = Array.isArray(prodQuery.body) ? prodQuery.body : [];
out.layer_a_direct_rest.production_filter = {
  status: prodQuery.status,
  count: parseInt(prodQuery.contentRange?.split("/")[1] || "0", 10),
  body_was_array: Array.isArray(prodQuery.body),
  body_raw_if_not_array: Array.isArray(prodQuery.body) ? null : prodQuery.body,
  sample_first_3: prodBodyArr.slice(0, 3),
  any_d358_leaked: prodBodyArr.some((r) => r.backfill_run_id === out.d358_backfill_run_id),
};

// (iii) Sanity: query without filter — synthetic rows should appear
const noFilter = await restGet(`pick_history?sport=eq.mlb&select=is_synthetic&limit=50`);
const noFilterArr = Array.isArray(noFilter.body) ? noFilter.body : [];
const flagDistribution = noFilterArr.reduce((acc, r) => {
  acc[String(r.is_synthetic)] = (acc[String(r.is_synthetic)] || 0) + 1;
  return acc;
}, {});
out.layer_a_direct_rest.unfiltered_distribution_sample = {
  status: noFilter.status,
  is_synthetic_breakdown: flagDistribution,
};

// ----- Layer B: Puppeteer dashboard load -----

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  const restCalls = [];
  page.on("request", (req) => {
    const u = req.url();
    if (u.includes("/rest/v1/pick_history") || u.includes("/rest/v1/recommendations_cache")) {
      restCalls.push({ method: req.method(), url: u.split("?")[1]?.slice(0, 400) || u });
    }
  });

  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.evaluate((ls) => {
    for (const [k, v] of Object.entries(ls)) window.localStorage.setItem(k, v);
    window.localStorage.setItem("betgenius_user_sport", "mlb");
  }, session.localStorage);
  await page.reload({ waitUntil: "networkidle2", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 8000));

  // Navigate to Performance page
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) =>
      (b.innerText || "").trim().toLowerCase().startsWith("performance")
    );
    if (btn) btn.click();
  });
  await new Promise((r) => setTimeout(r, 6000));

  // Take screenshot
  await page.screenshot({ path: resolve(SHOTS_DIR, "performance_post_mint.png"), fullPage: true });

  // Scan DOM for telltale strings that would indicate synthetic leak
  const domScan = await page.evaluate(() => {
    const txt = document.body.innerText;
    return {
      mentions_synthetic_backfill: txt.includes("d358_synthetic_backfill"),
      mentions_synthetic_source: txt.includes("synthetic_backfill"),
      mentions_vs_red_sox: txt.includes("Atlanta Braves vs Boston Red Sox"),
      mentions_padres_vs_dodgers: txt.includes("San Diego Padres vs Los Angeles Dodgers"),
      text_length: txt.length,
    };
  });

  // Also check Stats page (which queries pick_history aggregates)
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) =>
      (b.innerText || "").trim().toLowerCase() === "stats"
    );
    if (btn) btn.click();
  });
  await new Promise((r) => setTimeout(r, 4000));
  await page.screenshot({ path: resolve(SHOTS_DIR, "stats_post_mint.png"), fullPage: true });

  out.layer_b_puppeteer = {
    rest_calls_to_pick_history: restCalls.filter((c) => c.url.includes("pick_history")).slice(0, 5),
    dom_scan: domScan,
    screenshots_dir: SHOTS_DIR,
  };
} finally {
  await browser.close();
}

writeFileSync(REPORT_FILE, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
