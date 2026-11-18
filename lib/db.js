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
    headers: { apikey: key(), Authorization: `Bearer ${key()}`, "Content-Type": "application/json", ...headers },
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
