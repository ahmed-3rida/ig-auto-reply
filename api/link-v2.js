// v2 lookup used by the viaSocket flows (the old /api/link stays as it was).
//
//   GET /api/link-v2?media_id=123
//   GET /api/link-v2?payload=<postback payload of the tapped button>
//
// -> { found, mode: "link" | "message" | "both", link, message, button, payload, hasLink, hasMessage }
//
//   mode "link"    -> payload is the link itself (exactly like v1, so old buttons keep working)
//   mode "message" / "both" -> payload is "msg:<media_id>"; after the follow check the flow
//                    calls this again with that payload to get the message (and the link).
//   button = the title of the first button (set per video in the panel, default "Link").
import { loadConfig, findRuleV2, effective, DEFAULT_BUTTON } from "../lib/config.js";
import { getCaption } from "./link.js";

const headers = { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };
const NONE = { found: false, mode: "", link: "", message: "", button: DEFAULT_BUTTON, payload: "", hasLink: false, hasMessage: false };
const out = (id, e, via) => ({
  found: true, mode: e.mode, link: e.link, message: e.message, button: e.button,
  payload: e.mode === "link" ? e.link : `msg:${id}`, hasLink: !!e.link, hasMessage: !!e.message, via,
});

export async function resolve(id) {
  const cfg = await loadConfig();
  if (!cfg.enabled) return NONE;
  const post = cfg.posts?.[id];
  if (post) { const e = effective(post); return e ? out(id, e, "post") : NONE; }
  if (!cfg.rules?.some((r) => effective(r))) return NONE;
  const rule = findRuleV2(await getCaption(id), cfg.rules);
  return rule ? out(id, effective(rule), "caption") : NONE;
}

export async function GET(request) {
  const q = new URL(request.url).searchParams;
  const payload = (q.get("payload") ?? "").trim();
  if (payload) {
    // A button sent before v2 (or a link-only video): the payload is the link.
    if (/^https?:\/\/\S+$/i.test(payload)) {
      return Response.json({ ...NONE, found: true, mode: "link", link: payload, payload, hasLink: true, via: "payload" }, { headers });
    }
    const m = payload.match(/^msg:(\d+)$/);
    if (!m) return Response.json({ ...NONE, error: "unknown payload" }, { status: 400, headers });
    return Response.json(await resolve(m[1]), { headers });
  }
  const id = q.get("media_id") ?? "";
  if (!/^\d+$/.test(id)) return Response.json({ ...NONE, error: "media_id required" }, { status: 400, headers });
  return Response.json(await resolve(id), { headers });
}
