// Panel API. Every request must send header `x-admin-key` = VERIFY_TOKEN (the panel password).
//   GET  /api/admin?action=config            -> settings of every video + Zernio numbers
//   GET  /api/admin?action=media[&after=...] -> your Instagram posts (thumbnails for the panel)
//   POST /api/admin  { enabled, settings, posts, rules } -> save, then update Zernio
//   POST /api/admin?action=resync            -> send every video to Zernio again
import crypto from "node:crypto";
import { loadConfig, saveConfig, cleanConfig } from "../lib/config.js";
import { hasZernio, listAutomations, listPosts, deleteAutomation, ZernioError } from "../lib/zernio.js";
import { syncAll, adoptExternal, statsByPost } from "../lib/sync.js";

const env = (k, d = "") => process.env[k] ?? d;
const GRAPH = () => `https://graph.instagram.com/${env("GRAPH_VERSION", "v24.0")}`;

const password = () => (env("ADMIN_PASSWORD") || env("VERIFY_TOKEN")).trim();

function authorized(request) {
  const want = password();
  const got = (request.headers.get("x-admin-key") ?? "").trim();
  if (!want) return false;
  const a = Buffer.from(want), b = Buffer.from(got);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const json = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
// No password set on this deployment (e.g. a Preview without the variable) is not the same as a wrong password.
const denied = () => password()
  ? json({ error: "unauthorized" }, 401)
  : json({ error: "no-password", message: "VERIFY_TOKEN مش متضاف في Vercel للبيئة دي (Production/Preview)" }, 503);

// Current config with automations made directly in Zernio folded in, plus per-video numbers.
async function current() {
  const cfg = await loadConfig({ fresh: true });
  const out = { cfg, stats: {}, zernio: { connected: hasZernio(), error: "" } };
  if (!hasZernio()) return out;
  try {
    const autos = await listAutomations();
    adoptExternal(cfg, autos);
    out.stats = statsByPost(autos);
  } catch (e) {
    out.zernio.error = e.message;
  }
  return out;
}

const typeOf = (permalink = "") => (/\/reel\//.test(permalink) ? "REEL" : "IMAGE");

export async function GET(request) {
  if (!authorized(request)) return denied();
  const u = new URL(request.url);
  const action = u.searchParams.get("action");

  if (action === "config") {
    const { cfg, stats, zernio } = await current();
    return json({ config: cfg, stats, zernio, storage: !!env("BLOB_READ_WRITE_TOKEN") });
  }

  if (action === "media") {
    const after = u.searchParams.get("after");
    // Zernio lists the posts (no Instagram token needed); the Instagram API is the fallback.
    if (hasZernio()) {
      try {
        const d = await listPosts(after);
        const items = d.items.map((m) => ({
          id: m.id,
          caption: (m.content ?? "").slice(0, 1000),
          type: typeOf(m.permalink),
          thumb: m.picture || m.thumbnail || "",
          permalink: m.permalink,
          timestamp: m.createdTime,
          comments: m.commentCount ?? null,
        }));
        return json({ items, after: d.after });
      } catch (e) {
        if (!env("IG_ACCESS_TOKEN")) return json({ error: e.message }, 502);
      }
    }
    const q = new URLSearchParams({
      fields: "id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp,comments_count",
      limit: "24",
    });
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
      comments: m.comments_count ?? null,
    }));
    return json({ items, after: data.paging?.next ? data.paging?.cursors?.after : null });
  }

  return json({ error: "unknown action" }, 400);
}

const SERVER_FIELDS = ["automationId", "syncedHash", "syncError", "via"];

export async function POST(request) {
  if (!authorized(request)) return denied();
  const action = new URL(request.url).searchParams.get("action");
  let body = {};
  if (action !== "resync") {
    try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  }
  try {
    const { cfg: now } = await current();
    let next;
    if (action === "resync") {
      next = now;
    } else {
      next = cleanConfig(body);
      // Zernio bookkeeping comes from the server, never from the browser.
      for (const [id, p] of Object.entries(next.posts)) {
        for (const k of SERVER_FIELDS) p[k] = now.posts[id]?.[k] ?? "";
      }
      // A video removed from the panel: remove its automation on Zernio too.
      if (hasZernio()) {
        for (const [id, p] of Object.entries(now.posts)) {
          if (p.automationId && !next.posts[id]) {
            await deleteAutomation(p.automationId).catch((e) => { if (!(e instanceof ZernioError && e.status === 404)) throw e; });
          }
        }
      }
    }
    const report = hasZernio() ? await syncAll(next, { force: action === "resync" }) : null;
    const saved = await saveConfig(next);
    const { stats, zernio } = hasZernio() ? await current() : { stats: {}, zernio: { connected: false, error: "" } };
    return json({ ok: true, config: saved, report, stats, zernio });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
