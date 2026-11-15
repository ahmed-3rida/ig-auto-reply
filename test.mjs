// Local test: simulates Meta webhooks + the settings API without calling Instagram or real storage.
// Needs a stub for @vercel/blob on NODE_PATH-like resolution (see README) or the real package installed.
process.env.VERIFY_TOKEN = "abc";
process.env.BLOB_READ_WRITE_TOKEN = "test";
const calls = [];
let FOLLOWS = true;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.startsWith("https://blob.test/")) {
    const b = globalThis.__blobs.find((x) => x.url === url);
    return new Response(b.body, { status: 200 });
  }
  if (url.includes("/me/media")) {
    return Response.json({ data: [{ id: "M1", caption: "ريل 1", media_type: "VIDEO", media_product_type: "REELS", thumbnail_url: "t", permalink: "p", timestamp: "2026-11-01T00:00:00+0000" }], paging: {} });
  }
  if (/\/U7\?fields=is_user_follow_business/.test(url)) return Response.json({ is_user_follow_business: FOLLOWS });
  calls.push([url, JSON.parse(opts.body)]);
  return new Response("{}", { status: 200 });
};
const { GET, POST, matchesKeyword, handleComment } = await import("./api/webhook.js");
const admin = await import("./api/admin.js");
const assert = (c, m) => { if (!c) { console.error("FAIL", m); process.exit(1); } console.log("ok", m); };

assert(matchesKeyword("عايز التحميل لو سمحت", "تحميل"), "keyword inside sentence");
assert(matchesKeyword("أي حاجة", ""), "empty keyword = every comment");
assert(!matchesKeyword("شكرا", "تحميل"), "keyword mismatch");
assert((await (await GET(new Request("https://x/api/webhook?hub.mode=subscribe&hub.verify_token=abc&hub.challenge=42"))).text()) === "42", "verify handshake");
assert((await GET(new Request("https://x/api/webhook?hub.mode=subscribe&hub.verify_token=no&hub.challenge=42"))).status === 403, "bad verify token");

// Settings API
const req = (path, init = {}, key = "abc") => new Request("https://x" + path, { ...init, headers: { "x-admin-key": key, "content-type": "application/json" } });
assert((await admin.GET(req("/api/admin?action=config", {}, "wrong"))).status === 401, "admin rejects wrong password");
const defaults = (await (await admin.GET(req("/api/admin?action=config"))).json()).config;
assert(defaults.posts["17978249321939264"].link === "https://github.com/mutonby/openshorts" && defaults.commentReplies.length > 10, "defaults copied from viaSocket");
const media = await (await admin.GET(req("/api/admin?action=media"))).json();
assert(media.items[0].id === "M1" && media.items[0].type === "REEL", "admin lists posts");
const saveRes = await admin.POST(req("/api/admin", { method: "POST", body: JSON.stringify({
  ...defaults,
  commentReplies: ["رد {username}"], dmMessages: ["دوس LINK"], followerReplies: ["اتفضل"], nonFollowerMessages: ["فولو الأول"],
  posts: { "111": { enabled: true, link: "https://a.com/1" }, "222": { enabled: true, link: "https://b.com/2", keyword: "لينك", dm: "خاص" }, "333": { enabled: false, link: "https://c.com" } },
}) }));
assert(saveRes.status === 200, "admin saves settings");
const cfg = (await (await admin.GET(req("/api/admin?action=config"))).json()).config;
assert(cfg.posts["222"].link === "https://b.com/2" && !cfg.posts["17978249321939264"], "settings read back");

const ev = (fromId, text, media) => new Request("https://x/api/webhook", { method: "POST", body: JSON.stringify({
  entry: [{ id: "OWNER", changes: [{ field: "comments", value: { id: "C1", text, from: { id: fromId, username: "ahmed" }, media: { id: media } } }] }] }) });

calls.length = 0;
await POST(ev("U1", "حلو جدا", "111"));
assert(calls.length === 2 && calls[0][0].endsWith("/C1/replies") && calls[0][1].message === "رد ahmed", "public reply first (random list)");
const t = calls[1][1].message.attachment.payload;
assert(calls[1][1].recipient.comment_id === "C1" && t.text === "دوس LINK" && t.buttons[0].type === "postback" && t.buttons[0].title === "Link" && t.buttons[0].payload === "https://a.com/1", "private reply with Link button carrying this post's link");

calls.length = 0;
await POST(ev("U1", "ابعت لينك", "222"));
assert(calls.length === 2 && calls[1][1].message.attachment.payload.text === "خاص" && calls[1][1].message.attachment.payload.buttons[0].payload === "https://b.com/2", "post 222 uses its own link + fixed DM");
calls.length = 0;
await POST(ev("U1", "حلو", "222"));
assert(calls.length === 0, "post with keyword ignores other comments");

calls.length = 0;
await POST(ev("U1", "حلو", "333"));
await POST(ev("U1", "حلو", "999"));
await POST(ev("OWNER", "حلو", "111"));
assert(calls.length === 0, "ignores disabled posts, unconfigured posts and own comments");

// Postbacks (tap on Link / Following)
const pb = (payload) => new Request("https://x/api/webhook", { method: "POST", body: JSON.stringify({
  entry: [{ id: "OWNER", messaging: [{ sender: { id: "U7" }, recipient: { id: "OWNER" }, postback: { mid: "MID1", title: "Link", payload } }] }] }) });
FOLLOWS = true; calls.length = 0;
await POST(pb("https://a.com/1"));
assert(calls.length === 2 && calls[0][1].sender_action === "react" && calls[0][1].payload.message_id === "MID1", "follower: react ❤️");
const lt = calls[1][1].message.attachment.payload;
assert(calls[1][1].recipient.id === "U7" && lt.text === "اتفضل" && lt.buttons[0].type === "web_url" && lt.buttons[0].url === "https://a.com/1" && lt.buttons[0].title === "دوس هنا", "follower: gets URL button with the link");
FOLLOWS = false; calls.length = 0;
await POST(pb("https://a.com/1"));
const nf = calls[0][1].message.attachment.payload;
assert(calls.length === 1 && nf.text === "فولو الأول" && nf.buttons[0].type === "postback" && nf.buttons[0].title === "Following" && nf.buttons[0].payload === "https://a.com/1", "non-follower: asked to follow + Following button");
calls.length = 0;
await POST(pb("SOMETHING_ELSE"));
assert(calls.length === 0, "ignores postbacks that aren't ours");

const off = await handleComment({ id: "C2", text: "x", from: { id: "U9" }, media: { id: "111" } }, "OWNER", { ...cfg, enabled: false });
assert(off === "disabled", "global switch off");
globalThis.fetch = realFetch;
