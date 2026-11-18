// Tracked link: /api/go?m=<media>&u=<user key>&s=<signature> -> logs a click, then sends the person to the
// video's current link. Links sent by the panel go through here so the stats can count clicks.
import { loadConfig, effective } from "../lib/config.js";
import { checkTracked } from "../lib/respond.js";
import { logEvent } from "../lib/events.js";

export async function GET(request) {
  const q = new URL(request.url).searchParams;
  const m = q.get("m") ?? "", u = q.get("u") ?? "", s = q.get("s") ?? "";
  if (!/^\d+$/.test(m) || !/^[a-f0-9]{12}$/.test(u) || !checkTracked(m, u, s)) return new Response("Not found", { status: 404 });
  const cfg = await loadConfig();
  const e = effective(cfg.posts[m]);
  if (!e?.link) return new Response("This link is no longer available.", { status: 410 });
  await logEvent("click", m, "k:" + u);
  return new Response(null, { status: 302, headers: { Location: e.link, "Cache-Control": "no-store" } });
}
