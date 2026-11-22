// TikTok: post an Instagram video to TikTok, replies under its comments, and the video's word in TikTok DMs.
// Run: node --import ./test/register.mjs test/tiktok.test.mjs
import crypto from "node:crypto";
process.env.VERIFY_TOKEN = "abc";
process.env.ZERNIO_API_KEY = "zk";
process.env.ZERNIO_WEBHOOK_SECRET = "whsec";
process.env.SUPABASE_URL = "https://sb.test";
process.env.SUPABASE_SECRET_KEY = "sb_secret_x";
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.IG_ACCESS_TOKEN;

const IG = "6afd7f3a4a29a11a85dec5e5", TT = "6aff738dc1392d5b90b51d95", PROF = "6afd7f1800e3468668318f56";
const VID = "18091667573283321";
const Z = { autos: new Map(), posts: new Map(), sent: [], seq: 0, row: null, events: [] };
const hex = () => (++Z.seq).toString(16).padStart(24, "b");
Z.row = { enabled: true, settings: {}, rules: [], posts: { [VID]: { enabled: true, mode: "link", link: "https://github.com/tashfeenahmed/freellmapi", button: "FreeLLMAPI", gate: true, keywords: "" } } };

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const u = new URL(url), method = init.method ?? "GET", body = init.body ? JSON.parse(init.body) : null;
  if (u.origin === "https://sb.test") {
    if (u.pathname === "/rest/v1/app_config" && method === "GET") return Response.json(Z.row ? [{ id: "main", data: Z.row }] : []);
    if (u.pathname === "/rest/v1/app_config" && method === "POST") { Z.row = body.data ?? body[0]?.data; return new Response(null, { status: 201 }); }
    if (u.pathname === "/rest/v1/events" && method === "POST") { Z.events.push(body); return new Response(null, { status: 201 }); }
    return Response.json([]);
  }
  if (u.origin !== "https://zernio.com") throw new Error("unexpected fetch " + url);
  const path = u.pathname.replace(/^\/api/, "");
  if (Z.limited > 0 && path.endsWith("/messages") && method === "POST") { Z.limited--; return new Response(JSON.stringify({ error: "Rate limit exceeded. Please retry after 2 seconds." }), { status: 429, headers: { "retry-after": "2" } }); }
  if (path === "/v1/accounts") {
    const p = u.searchParams.get("platform");
    if (p === "tiktok") return Response.json({ accounts: [{ _id: TT, platform: "tiktok", username: "a7med.salman.3rida", profileId: { _id: PROF } }] });
    return Response.json({ accounts: [{ _id: IG, platform: "instagram", profileId: { _id: PROF } }] });
  }
  if (path === `/v1/inbox/comments/${VID}` && method === "GET") return Response.json({ comments: [], post: { id: VID, mediaType: "VIDEO", mediaUrl: "https://cdn.ig/v.mp4",
    text: "10 مليار توكن ببلاش 🤯\r\n\r\nاكتب FreeLLMAPI في الكومنت وهبعتلك اللينك على الخاص 📩\r\n\r\n#ClaudeCode" } });
  if (path === "/v1/inbox/comments" && method === "GET") return Response.json({ data: [{ id: VID, content: "اكتب FreeLLMAPI في الكومنت وهبعتلك اللينك" }], pagination: { hasMore: false } });
  if (path === "/v1/posts" && method === "POST") {
    if (body.platforms[0].accountId !== TT || !body.tiktokSettings?.express_consent_given) return Response.json({ error: "bad" }, { status: 400 });
    const p = { _id: hex(), status: "scheduled", ...body, platforms: [{ platform: "tiktok", status: "pending" }] };
    Z.posts.set(p._id, p); return Response.json({ post: p }, { status: 201 });
  }
  const gp = path.match(/^\/v1\/posts\/(\w+)$/);
  if (gp) return Response.json({ post: Z.posts.get(gp[1]) });
  if (path === "/v1/comment-automations" && method === "GET") return Response.json({ automations: [...Z.autos.values()] });
  if (path === "/v1/comment-automations" && method === "POST") { const a = { ...body, _id: hex(), platform: body.accountId === TT ? "tiktok" : "instagram" }; Z.autos.set(a._id, a); return Response.json({ automation: a }); }
  const am = path.match(/^\/v1\/comment-automations\/(\w+)$/);
  if (am && method === "PATCH") { Object.assign(Z.autos.get(am[1]), body); return Response.json({ automation: Z.autos.get(am[1]) }); }
  const sm = path.match(/^\/v1\/inbox\/conversations\/(\w+)\/messages$/);
  if (sm && method === "POST") { Z.sent.push({ conv: sm[1], ...body }); return Response.json({ success: true }); }
  throw new Error("unhandled zernio call " + method + " " + path);
};

const assert = (c, msg) => { if (!c) { console.error("FAIL", msg); process.exit(1); } console.log("ok", msg); };
const admin = await import("../api/admin.js");
const hook = await import("../api/zernio-webhook.js");
const { tiktokCaption, findTiktokVideo, tiktokDmText } = await import("../lib/tiktok.js");
const { cleanConfig } = await import("../lib/config.js");
const H = { "x-admin-key": "abc", "Content-Type": "application/json" };

// caption: the comment line becomes the DM line
const cap = tiktokCaption("فيديو\nاكتب FreeLLMAPI في الكومنت وهبعتلك اللينك على الخاص 📩\n#tag");
assert(cap === "فيديو\nابعتلي FreeLLMAPI في الخاص وهيوصلك اللينك 📩\n#tag", "caption line rewritten for TikTok");
assert(tiktokCaption("مفيش كلمة", "IDM").endsWith("ابعتلي IDM في الخاص وهيوصلك اللينك 📩"), "caption without the line gets one added");

// publish needs the review tick
let r = await admin.POST(new Request(`https://x/api/admin?action=tiktok-publish&id=${VID}`, { method: "POST", headers: H, body: JSON.stringify({ word: "FreeLLMAPI" }) }));
assert(r.status === 400, "publish refused without confirm");

r = await admin.POST(new Request(`https://x/api/admin?action=tiktok-publish&id=${VID}`, { method: "POST", headers: H, body: JSON.stringify({ word: "FreeLLMAPI", confirm: true }) }));
let d = await r.json();
assert(r.status === 200 && d.tiktok.status === "scheduled" && /^[a-f0-9]{24}$/.test(d.tiktok.postId), "posted to TikTok (scheduled)");
const post = Z.posts.get(d.tiktok.postId);
assert(post.mediaItems[0].url === "https://cdn.ig/v.mp4" && post.content.includes("ابعتلي FreeLLMAPI في الخاص"), "original video + TikTok caption");
const auto = Z.autos.get(d.tiktok.automationId);
assert(auto && auto.accountId === TT && auto.postId === d.tiktok.postId && auto.commentReply.includes("FreeLLMAPI") && !auto.dmMessage, "public-reply automation bound to the TikTok post");
assert(Z.row.posts[VID].tiktok?.postId === d.tiktok.postId, "TikTok post saved in the config");

r = await admin.POST(new Request(`https://x/api/admin?action=tiktok-publish&id=${VID}`, { method: "POST", headers: H, body: JSON.stringify({ word: "FreeLLMAPI", confirm: true }) }));
assert(r.status === 409, "can't post the same video twice");

// status
post.platforms[0] = { platform: "tiktok", status: "published", platformPostUrl: "https://www.tiktok.com/@a/video/1", platformPostId: "7300" };
r = await admin.GET(new Request(`https://x/api/admin?action=tiktok-status&id=${VID}`, { headers: H }));
d = await r.json();
assert(d.tiktok.status === "published" && d.tiktok.url.includes("tiktok.com"), "status read back as published");

// the TikTok automation must not show up as an Instagram video
r = await admin.GET(new Request("https://x/api/admin?action=config", { headers: H }));
d = await r.json();
assert(!d.config.posts["7300"] && Object.keys(d.config.posts).length >= 1 && d.tiktok.connected, "TikTok automation not adopted as an Instagram video");

// a save keeps the server's TikTok data and syncs reply texts
const cfgB = d.config; cfgB.settings.ttReply = "ابعت {الكلمة} يا معلم"; cfgB.posts[VID].tiktok = { postId: "f".repeat(24) }; // browser can't overwrite it
r = await admin.POST(new Request("https://x/api/admin", { method: "POST", headers: H, body: JSON.stringify(cfgB) }));
d = await r.json();
assert(d.config.posts[VID].tiktok.postId === post._id, "browser can't change the TikTok record");
assert(Z.autos.get(d.config.posts[VID].tiktok.automationId).commentReply === "ابعت FreeLLMAPI يا معلم", "reply texts synced to the TikTok automation");

// DMs
const sign = (raw) => crypto.createHmac("sha256", "whsec").update(raw).digest("hex");
const dm = async (text, extra = {}) => {
  const raw = JSON.stringify({ event: "message.received", message: { platform: "tiktok", direction: "incoming", text, sender: { id: "u" + Math.random() }, conversationId: "c1", ...extra }, conversation: { id: "c1" }, account: { id: TT } });
  const res = await hook.POST(new Request("https://x/api/zernio-webhook", { method: "POST", body: raw, headers: { "x-zernio-signature": sign(raw) } }));
  return res.json();
};
let a = await dm("FreeLLMAPI");
assert(a.answered === "tiktok" && Z.sent.at(-1).accountId === TT && Z.sent.at(-1).message.endsWith("\nhttps://github.com/tashfeenahmed/freellmapi") && !Z.sent.at(-1).buttons, "word in a TikTok DM -> text + link, no buttons");
a = await dm("ابعتلي freellmapi لو سمحت");
assert(a.answered === "tiktok", "word inside a sentence, any case");
const n = Z.sent.length;
a = await dm("ازيك");
assert(a.skipped === "no-keyword" && Z.sent.length === n, "no word -> no answer");
a = await dm("FreeLLMAPI", { direction: "outgoing" });
assert(a.skipped === "outgoing", "own messages ignored");

// Zernio's rate limit: wait and try again instead of dropping the message
(await import("../lib/zernio.js")).rateLimit.scale = 0;
Z.limited = 2; const before = Z.sent.length;
a = await dm("FreeLLMAPI");
assert(a.answered === "tiktok" && Z.sent.length === before + 1 && Z.limited === 0, "429 from Zernio retried, message still sent");

// matching helpers
const cfg = cleanConfig({ settings: {}, posts: { "1": { enabled: true, link: "https://a.b", keywords: "IDM" }, "2": { enabled: true, link: "https://c.d" }, "3": { enabled: false, link: "https://e.f", keywords: "OFF" } } });
assert(findTiktokVideo(cfg, "عايز idm")?.id === "1", "own keyword matches");
assert(findTiktokVideo(cfg, "send", new Map([["2", "SEND"]]))?.id === "2", "caption word matches");
assert(!findTiktokVideo(cfg, "OFF"), "disabled video not answered");
assert(tiktokDmText({ enabled: true, mode: "message", message: "الخطوات" }, cfg.settings) === "الخطوات", "message-only video sends its message");

// turned off in the settings
Z.row.settings.tiktok = false;
const { loadConfig } = await import("../lib/config.js"); await loadConfig({ fresh: true });
a = await dm("FreeLLMAPI");
assert(a.skipped === "off", "TikTok off in the settings -> no answer");
console.log("all tiktok tests passed");
