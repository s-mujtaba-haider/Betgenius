// D-683 SHIP 1 — export cache_mlb_historical_odds → Storage as CSV.gz shards.
//
// Streaming export: query in 25K-row pages, CSV-encode each page, gzip-append
// each compressed page (concatenated gzip streams are valid gzip), upload
// final buffer to Storage. Memory cap ≈ 50MB (one page raw + running gz).
//
// Trigger: POST {"year": Y, "month": M, "dry_run"?: bool} OR
//          POST {"year": Y, "start_day": D, "end_day": D} for finer shards.
// Auth: x-d683-key header == D683_EXPORT_KEY secret.

import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts"

interface ExportRequest {
  year: number
  month?: number
  start_day?: number  // for finer 2-week or weekly shards within a month
  end_day?: number
  dry_run?: boolean
}

const BUCKET = "historical-odds-cold"
const TABLE = "public.cache_mlb_historical_odds"
const COLS = [
  "event_id", "snapshot_timestamp", "commence_time",
  "home_team", "away_team", "bookmaker_key", "bookmaker_title",
  "market_key", "player_name", "line", "over_odds", "under_odds",
  "fetched_at",
]
const COLS_SQL = COLS.join(",")
const PAGE = 25000

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 })
  const xkey = req.headers.get("x-d683-key") ?? ""
  const expected = Deno.env.get("D683_EXPORT_KEY") ?? ""
  if (!expected || xkey !== expected) {
    return new Response(JSON.stringify({ err: "unauthorized" }),
      { status: 401, headers: { "content-type": "application/json" } })
  }
  const sr = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  if (!sr) return new Response("server_misconfigured", { status: 500 })

  let body: ExportRequest
  try { body = await req.json() } catch { return j({ ok: false, err: "bad_json" }, 400) }
  if (!body.year || body.year < 2023 || body.year > 2027) {
    return j({ ok: false, err: "bad_year" }, 400)
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? ""
  const dbUrl = Deno.env.get("SUPABASE_DB_URL") ?? ""
  if (!dbUrl) return j({ ok: false, err: "no_db_url" }, 500)

  // Compute date range
  let startDate: string, endDate: string, key: string
  if (body.start_day !== undefined && body.end_day !== undefined && body.month !== undefined) {
    const m = String(body.month).padStart(2, "0")
    const sd = String(body.start_day).padStart(2, "0")
    const ed = String(body.end_day).padStart(2, "0")
    startDate = `${body.year}-${m}-${sd}`
    endDate = `${body.year}-${m}-${ed}`  // exclusive
    key = `odds_${body.year}_${m}_${sd}-${ed}.csv.gz`
  } else if (body.month) {
    const m = String(body.month).padStart(2, "0")
    startDate = `${body.year}-${m}-01`
    const nextM = body.month === 12 ? 1 : body.month + 1
    const nextY = body.month === 12 ? body.year + 1 : body.year
    endDate = `${nextY}-${String(nextM).padStart(2, "0")}-01`
    key = `odds_${body.year}_${m}.csv.gz`
  } else {
    startDate = `${body.year}-01-01`
    endDate = `${body.year + 1}-01-01`
    key = `odds_${body.year}.csv.gz`
  }

  const client = new Client(dbUrl)
  let rowCount = 0
  let csvBytes = 0
  const gzChunks: Uint8Array[] = []
  try {
    await client.connect()

    // Count rows for verification first
    const cr = await client.queryObject<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${TABLE} WHERE commence_time >= $1 AND commence_time < $2`,
      [startDate, endDate],
    )
    rowCount = Number(cr.rows[0]?.n ?? 0)
    if (rowCount === 0) {
      await client.end()
      return j({ ok: true, key, row_count: 0, note: "shard_empty", uploaded: false })
    }
    if (body.dry_run) {
      await client.end()
      return j({ ok: true, key, row_count: rowCount, note: "dry_run", uploaded: false })
    }

    // Stream CSV header + paged rows → gzip each batch → accumulate
    let headerLine = COLS.join(",") + "\n"
    let pageBuf = headerLine
    let lastCt: string | null = null
    let lastEv: string | null = null
    let exported = 0
    while (true) {
      const q = lastCt === null
        ? `SELECT ${COLS_SQL} FROM ${TABLE} WHERE commence_time >= $1 AND commence_time < $2 ORDER BY commence_time, event_id LIMIT ${PAGE}`
        : `SELECT ${COLS_SQL} FROM ${TABLE} WHERE commence_time >= $1 AND commence_time < $2 AND (commence_time, event_id) > ($3::timestamptz, $4::text) ORDER BY commence_time, event_id LIMIT ${PAGE}`
      const params = lastCt === null
        ? [startDate, endDate]
        : [startDate, endDate, lastCt, lastEv]
      const rs = await client.queryObject<Record<string, unknown>>(q, params)
      if (rs.rows.length === 0) break
      for (const r of rs.rows) {
        pageBuf += csvEncodeRow(r) + "\n"
        const ct = r.commence_time
        lastCt = ct instanceof Date ? ct.toISOString() : String(ct)
        lastEv = String(r.event_id)
      }
      exported += rs.rows.length
      // Gzip this page's buffer, append, reset
      const csvU8 = new TextEncoder().encode(pageBuf)
      csvBytes += csvU8.length
      const gz = await gzipBytes(csvU8)
      gzChunks.push(gz)
      pageBuf = ""  // reset for next page; header already emitted
      if (rs.rows.length < PAGE) break
    }
    if (exported !== rowCount) {
      console.warn(`D-683 export count mismatch year=${body.year} mo=${body.month}: expected=${rowCount} actual=${exported}`)
    }
  } catch (e) {
    try { await client.end() } catch { /* */ }
    return j({ ok: false, err: "db_error", detail: String(e).slice(0, 500) }, 500)
  } finally {
    try { await client.end() } catch { /* */ }
  }

  // Concatenate gz chunks (concatenated gzip is valid gzip).
  let total = 0; for (const c of gzChunks) total += c.length
  const finalGz = new Uint8Array(total)
  let off = 0; for (const c of gzChunks) { finalGz.set(c, off); off += c.length }

  // Upload to Storage
  const upUrl = `${supabaseUrl}/storage/v1/object/${BUCKET}/${key}`
  const upRes = await fetch(upUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${sr}`,
      "Content-Type": "application/gzip",
      "x-upsert": "true",
    },
    body: finalGz,
  })
  if (!upRes.ok) {
    const err = await upRes.text()
    return j({ ok: false, err: "upload_failed", status: upRes.status, detail: err.slice(0, 400) }, 502)
  }

  return j({
    ok: true,
    key,
    row_count: rowCount,
    csv_bytes: csvBytes,
    gz_bytes: finalGz.length,
    compression_ratio: Number((csvBytes / Math.max(finalGz.length, 1)).toFixed(2)),
  })
})

async function gzipBytes(u8: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream("gzip"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function csvEncodeRow(row: Record<string, unknown>): string {
  const parts: string[] = []
  for (const c of COLS) parts.push(csvEsc(row[c]))
  return parts.join(",")
}
function csvEsc(v: unknown): string {
  if (v === null || v === undefined) return ""
  let s: string
  if (v instanceof Date) s = v.toISOString()
  else if (typeof v === "string") s = v
  else s = String(v)
  if (s.includes(",") || s.includes("\"") || s.includes("\n") || s.includes("\r")) {
    s = '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}
function j(o: unknown, status = 200): Response {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } })
}
