// Public liveness check (no secrets): can the site read its saved settings, and what shape are they in?
import { list } from "@vercel/blob";
import { loadConfig } from "../lib/config.js";

export async function GET() {
  const out = { blobToken: !!process.env.BLOB_READ_WRITE_TOKEN, list: null, error: null, files: [], loaded: null };
  try {
    const r = await list({ prefix: "config/", limit: 20 });
    out.list = "ok";
    out.files = r.blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)).map((b) => ({ at: b.uploadedAt, size: b.size }));
    const newest = r.blobs[0] && await fetch(r.blobs[0].url, { cache: "no-store" });
    out.fetchStatus = newest?.status ?? null;
    if (newest && !newest.ok) out.fetchBody = (await newest.text()).slice(0, 300);
    if (r.blobs[0]) out.urlHost = new URL(r.blobs[0].url).host.replace(/^[^.]+/, "<store>");
  } catch (e) {
    out.list = "failed"; out.error = String(e?.message ?? e).slice(0, 300);
  }
  try {
    const cfg = await loadConfig({ fresh: true });
    const posts = Object.values(cfg.posts);
    out.loaded = { enabled: cfg.enabled, posts: posts.length, on: posts.filter((p) => p.enabled).length,
      gateOn: posts.filter((p) => p.gate).length, withAutomation: posts.filter((p) => p.automationId).length,
      gateStyle: cfg.settings.gateStyle, source: (await import("../lib/config.js")).storageState.source };
  } catch (e) { out.loaded = { error: String(e.message).slice(0, 200) }; }
  return Response.json(out, { headers: { "Cache-Control": "no-store" } });
}
