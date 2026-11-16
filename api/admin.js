// Panel API. Every request must send header `x-admin-key` = VERIFY_TOKEN (the panel password).
//   GET  /api/admin?action=config            -> which videos are on + their links
//   GET  /api/admin?action=media[&after=...] -> your Instagram posts (thumbnails for the panel)
//   POST /api/admin  { enabled, posts }       -> save
import crypto from "node:crypto";
import { loadConfig, saveConfig } from "../lib/config.js";

const env = (k, d = "") => process.env[k] ?? d;
const GRAPH = () => `https://graph.instagram.com/${env("GRAPH_VERSION", "v24.0")}`;

function authorized(request) {
  const want = env("ADMIN_PASSWORD") || env("VERIFY_TOKEN");
  const got = request.headers.get("x-admin-key") ?? "";
  if (!want) return false;
  const a = Buffer.from(want), b = Buffer.from(got);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const json = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(request) {
  if (!authorized(request)) return json({ error: "unauthorized" }, 401);
  const u = new URL(request.url);
  const action = u.searchParams.get("action");

  if (action === "config") {
    const cfg = await loadConfig({ fresh: true });
    return json({ config: cfg, storage: !!env("BLOB_READ_WRITE_TOKEN") });
  }

  if (action === "media") {
    const q = new URLSearchParams({
      fields: "id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp",
      limit: "24",
    });
    const after = u.searchParams.get("after");
    if (after) q.set("after", after);
    const res = await fetch(`${GRAPH()}/me/media?${q}`, { headers: { Authorization: `Bearer ${env("IG_ACCESS_TOKEN")}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return json({ error: data?.error?.message ?? "Graph error" }, 502);
    const items = (data.data ?? []).map((m) => ({
      id: m.id,
      caption: (m.caption ?? "").slice(0, 1000),
      type: m.media_product_type === "REELS" ? "REEL" : m.media_type,
      thumb: m.thumbnail_url || (m.media_type !== "VIDEO" ? m.media_url : ""),
      permalink: m.permalink,
      timestamp: m.timestamp,
    }));
    return json({ items, after: data.paging?.next ? data.paging?.cursors?.after : null });
  }

  return json({ error: "unknown action" }, 400);
}

export async function POST(request) {
  if (!authorized(request)) return json({ error: "unauthorized" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  try {
    const saved = await saveConfig(body);
    return json({ ok: true, config: saved });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
