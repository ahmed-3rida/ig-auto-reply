// Supabase (Postgres) through its REST API — no extra package. Server-side only: uses the secret key, which
// bypasses RLS; the tables have RLS on with no policies, so the public keys can't read or write them.
// Env: SUPABASE_URL, and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY).
const env = (k) => process.env[k] ?? "";
const url = () => (env("SUPABASE_URL") || env("NEXT_PUBLIC_SUPABASE_URL")).replace(/\/$/, "");
const key = () => env("SUPABASE_SECRET_KEY") || env("SUPABASE_SERVICE_ROLE_KEY");

export const hasDb = () => !!(url() && key());

export async function rest(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${url()}/rest/v1/${path}`, {
    method,
    // new keys (sb_secret_…) go in `apikey` only — they aren't JWTs, and a Bearer with one makes the request
    // anonymous; the old service_role key is a JWT and also goes in Authorization
    headers: { apikey: key(), ...(/^eyJ/.test(key()) ? { Authorization: `Bearer ${key()}` } : {}), "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

// ---- settings: one row (id = 'main')
export async function readConfigRow() {
  const rows = await rest("app_config?id=eq.main&select=data");
  return rows?.[0]?.data ?? null;
}
export async function writeConfigRow(data) {
  await rest("app_config?on_conflict=id", {
    method: "POST", body: { id: "main", data, updated_at: new Date().toISOString() },
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
  });
}

// ---- events
export async function insertEvent(e) {
  await rest("events", { method: "POST", body: e, headers: { Prefer: "return=minimal" } });
}
// All events since `since` (ISO), oldest first, paged 1000 at a time.
export async function selectEvents(since) {
  const out = [];
  for (let from = 0; from < 200_000; from += 1000) {
    const rows = await rest(`events?select=at,type,media,user_key&at=gte.${encodeURIComponent(since)}&order=at.asc`, {
      headers: { Range: `${from}-${from + 999}`, "Range-Unit": "items" },
    });
    out.push(...(rows ?? []));
    if (!rows || rows.length < 1000) break;
  }
  return out;
}

// How many rows of `table` match `filter` (PostgREST exact count, no rows sent back).
export async function countRows(table, filter = "") {
  const res = await fetch(`${url()}/rest/v1/${table}?select=*${filter ? "&" + filter : ""}`, {
    method: "HEAD",
    headers: { apikey: key(), ...(/^eyJ/.test(key()) ? { Authorization: `Bearer ${key()}` } : {}), Prefer: "count=exact", Range: "0-0", "Range-Unit": "items" },
    cache: "no-store",
  });
  if (!res.ok && res.status !== 206 && res.status !== 416) throw new Error(`Supabase ${res.status}`);
  const total = Number(String(res.headers.get("content-range") ?? "").split("/")[1]);
  return Number.isFinite(total) ? total : 0;
}

// ---- comments waiting for their first DM (hourly cap reached)
export async function enqueuePending(row) {
  await rest("pending_replies?on_conflict=comment_id", { method: "POST", body: row, headers: { Prefer: "resolution=ignore-duplicates,return=minimal" } });
}
// The oldest waiting comments, each claimed by deleting it (so two servers never send the same one).
export async function takePending(limit) {
  const rows = await rest(`pending_replies?select=comment_id&order=queued_at.asc&limit=${limit}`) ?? [];
  const out = [];
  for (const r of rows) {
    const got = await rest(`pending_replies?comment_id=eq.${encodeURIComponent(r.comment_id)}`, { method: "DELETE", headers: { Prefer: "return=representation" } });
    if (got?.[0]) out.push(got[0]);
  }
  return out;
}
