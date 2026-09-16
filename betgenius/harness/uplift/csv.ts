// Minimal streaming CSV writer (no deps).
export async function writeCsv(path: string, rows: Record<string, unknown>[]): Promise<void> {
  await Deno.mkdir(path.substring(0, path.lastIndexOf("/")), { recursive: true });
  const f = await Deno.open(path, { write: true, create: true, truncate: true });
  const enc = new TextEncoder();
  if (rows.length === 0) {
    f.close();
    return;
  }
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  let buf = cols.join(",") + "\n";
  for (const r of rows) {
    buf += cols.map((c) => esc(r[c])).join(",") + "\n";
    if (buf.length > 1 << 20) {
      await f.write(enc.encode(buf));
      buf = "";
    }
  }
  if (buf) await f.write(enc.encode(buf));
  f.close();
  console.log(`[csv] wrote ${path} (${rows.length} rows)`);
}
