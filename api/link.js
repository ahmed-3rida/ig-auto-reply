// Read-only lookup used by the viaSocket flow:
//   GET /api/link?media_id=123  ->  { found: true, link: "https://...", via: "post" | "caption" }
//   Unknown / turned-off video   ->  { found: false, link: "" }
//
// 1) The video has its own entry in the panel -> use it (turned off = nothing).
// 2) Otherwise (e.g. a video that was scheduled before it existed) -> read its caption from
//    Instagram and use the first panel rule whose phrase appears in the caption.
// It only returns the link that commenters receive anyway, so it needs no password.
import { loadConfig, findRule } from "../lib/config.js";

const env = (k, d = "") => process.env[k] ?? d;
const GRAPH = () => `https://graph.instagram.com/${env("GRAPH_VERSION", "v24.0")}`;
const captions = new Map(); // mediaId -> caption (captions rarely change; per-instance cache)

export async function getCaption(id) {
  if (captions.has(id)) return captions.get(id);
  if (!env("IG_ACCESS_TOKEN")) return "";
  try {
    const res = await fetch(`${GRAPH()}/${id}?fields=caption`, { headers: { Authorization: `Bearer ${env("IG_ACCESS_TOKEN")}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { console.error("caption lookup failed", id, res.status, JSON.stringify(data)); return ""; }
    const cap = data.caption ?? "";
    captions.set(id, cap);
    return cap;
  } catch (e) {
    console.error("caption lookup error", e?.message);
    return "";
  }
}

export async function GET(request) {
  const id = new URL(request.url).searchParams.get("media_id") ?? "";
  const headers = { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };
  const none = (extra = {}) => Response.json({ found: false, link: "", ...extra }, { headers });
  if (!/^\d+$/.test(id)) return Response.json({ found: false, link: "", error: "media_id required" }, { status: 400, headers });

  const cfg = await loadConfig();
  if (!cfg.enabled) return none();

  const post = cfg.posts?.[id];
  if (post) {
    const ok = post.enabled && /^https?:\/\//i.test(post.link ?? "");
    return ok ? Response.json({ found: true, link: post.link, via: "post" }, { headers }) : none();
  }

  if (!cfg.rules?.some((r) => r.enabled)) return none();
  const rule = findRule(await getCaption(id), cfg.rules);
  return rule ? Response.json({ found: true, link: rule.link, via: "caption" }, { headers }) : none();
}
