// Read-only lookup for automations (viaSocket etc.):
//   GET /api/link?media_id=123  ->  { found: true, link: "https://...", keyword: "" }
//   Unknown / disabled post     ->  { found: false, link: "" }
// Only returns the link that commenters receive anyway, so it needs no password.
import { loadConfig } from "../lib/config.js";

export async function GET(request) {
  const id = new URL(request.url).searchParams.get("media_id") ?? "";
  const headers = { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };
  if (!/^\d+$/.test(id)) return Response.json({ found: false, link: "", error: "media_id required" }, { status: 400, headers });

  const cfg = await loadConfig();
  const post = cfg.posts?.[id];
  const ok = cfg.enabled && post?.enabled && /^https?:\/\//i.test(post?.link ?? "");
  return Response.json(ok ? { found: true, link: post.link, keyword: post.keyword ?? "" } : { found: false, link: "" }, { headers });
}
