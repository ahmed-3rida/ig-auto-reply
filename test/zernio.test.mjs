// Panel <-> Zernio sync and the upcoming-video webhook, against a fake Zernio API.
// Run: node --import ./test/register.mjs test/zernio.test.mjs
import crypto from "node:crypto";
process.env.VERIFY_TOKEN = "abc";
process.env.BLOB_READ_WRITE_TOKEN = "test";
process.env.ZERNIO_API_KEY = "zk";
process.env.ZERNIO_WEBHOOK_SECRET = "whsec";
delete process.env.IG_ACCESS_TOKEN;

const ACC = "6afd7f3a4a29a11a85dec5e5", PROF = "6afd7f1800e3468668318f56";
const Z = { autos: new Map(), calls: [], privateReplies: [], publicReplies: [], seq: 0 };
const hex = () => (++Z.seq).toString(16).padStart(24, "a");
// one automation made directly in Zernio (like the one set up by hand before the panel)
Z.autos.set("6afd84f0555dda08a89e3f12", { _id: "6afd84f0555dda08a89e3f12", platformPostId: "18098088275062213", trigger: "comment", keywords: [],
  commentReply: "تم الرد", dmMessage: "https://www.instagram.com/p/Da_MSaTjZqT/", isActive: true, audience: { followerStatus: "follower" },
  postTitle: "@thesevendogsfilm 🔥", stats: { dmsSent: 3, linkClicks: 1, triggered: 4 } });

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith("https://blob.test/")) return new Response(globalThis.__blobs.find((x) => x.url === url).body);
  const u = new URL(url);
  if (u.origin !== "https://zernio.com") throw new Error("unexpected fetch " + url);
  const method = init.method ?? "GET", body = init.body ? JSON.parse(init.body) : null, path = u.pathname.replace(/^\/api/, "");
  Z.calls.push(`${method} ${path}`);
  if (init.headers?.Authorization !== "Bearer zk") return Response.json({ error: "unauthorized" }, { status: 401 });
  if (path === "/v1/accounts") return Response.json({ accounts: [{ _id: ACC, platform: "instagram", profileId: { _id: PROF } }] });
  if (path === "/v1/comment-automations" && method === "GET") return Response.json({ automations: [...Z.autos.values()] });
  if (path === "/v1/comment-automations" && method === "POST") {
    if (body.profileId !== PROF || body.accountId !== ACC) return Response.json({ error: "ids" }, { status: 400 });
    if ([...Z.autos.values()].some((a) => a.platformPostId === body.platformPostId)) return Response.json({ error: "exists" }, { status: 409 });
    if (body.buttons?.length && body.dmMessage.length > 640) return Response.json({ error: "too long" }, { status: 400 });
    const a = { ...body, _id: hex(), stats: {} }; Z.autos.set(a._id, a);
    return Response.json({ success: true, automation: a });
  }
  const m = path.match(/^\/v1\/comment-automations\/(\w+)$/);
  if (m) {
    const a = Z.autos.get(m[1]);
    if (!a) return Response.json({ error: "not found" }, { status: 404 });
    if (method === "PATCH") { Object.assign(a, body); return Response.json({ success: true, automation: a }); }
    if (method === "DELETE") { Z.autos.delete(m[1]); return Response.json({ success: true }); }
  }
  if (path === "/v1/inbox/comments" && method === "GET") return Response.json({ data: [
    { id: "18098088275062213", content: "@thesevendogsfilm 🔥", permalink: "https://www.instagram.com/p/Da_MSaTjZqT/", picture: "pic", createdTime: "2026-07-19T20:10:28Z", commentCount: 7 },
    { id: "17978249321939264", content: "GTA", permalink: "https://www.instagram.com/reel/DfvN_5btSE2/", createdTime: "2026-11-14T21:55:44Z", commentCount: 1589 },
  ], pagination: { hasMore: true, nextCursor: "CUR" } });
  const pr = path.match(/^\/v1\/inbox\/comments\/(\w+)\/(\w+)\/private-reply$/);
  if (pr) { Z.privateReplies.push({ postId: pr[1], commentId: pr[2], ...body }); return Response.json({ success: true }); }
  const pub = path.match(/^\/v1\/inbox\/comments\/(\w+)$/);
  if (pub && method === "POST") { Z.publicReplies.push({ postId: pub[1], ...body }); return Response.json({ success: true }); }
  throw new Error("unhandled zernio call " + method + " " + path);
};

const admin = await import("../api/admin.js");
const hook = await import("../api/zernio-webhook.js");
const assert = (c, msg) => { if (!c) { console.error("FAIL", msg); process.exit(1); } console.log("ok", msg); };
const req = (path, init = {}) => new Request("https://x" + path, { ...init, headers: { "x-admin-key": "abc", "content-type": "application/json" } });
const getCfg = async () => (await admin.GET(req("/api/admin?action=config"))).json();
const save = async (cfg, qs = "") => (await admin.POST(req("/api/admin" + qs, { method: "POST", body: JSON.stringify(cfg) }))).json();
const autoFor = (id) => [...Z.autos.values()].find((a) => a.platformPostId === id);

// --- config: automations made in Zernio show up in the panel
let d = await getCfg();
assert(d.zernio.connected && !d.zernio.error, "panel reaches Zernio");
const hand = d.config.posts["18098088275062213"];
assert(hand && hand.enabled && hand.mode === "link" && hand.link === "https://www.instagram.com/p/Da_MSaTjZqT/" && hand.reply === "تم الرد" && hand.gate === true,
  "automation made directly in Zernio is shown as a panel video (link, reply, follow check)");
assert(d.stats["18098088275062213"].dmsSent === 3, "Zernio numbers come with the config");

// --- media listed through Zernio
const media = await (await admin.GET(req("/api/admin?action=media"))).json();
assert(media.items.length === 2 && media.items[1].type === "REEL" && media.items[0].thumb === "pic" && media.after === "CUR", "posts listed from Zernio");

// --- first save: old viaSocket videos become Zernio automations
Z.calls = [];
let r = await save(d.config);
assert(r.ok && r.report.failed === 0, "first save works");
assert(r.report.created === 12, "the 12 old viaSocket videos get a Zernio automation each");
const gta = autoFor("17978249321939264");
assert(gta.isActive && gta.keywords.length === 0 && gta.buttons[0].url === "https://github.com/mutonby/openshorts" && gta.buttons[0].type === "url"
  && gta.dmMessage === "اتفضل اللينك 👇" && gta.commentReply === "بعتلك في الخاص 📩", "link video -> DM text + link button + default public reply");
assert(gta.commentReplyVariations.length === 2 && gta.commentReplyVariations[1] === "تم الإرسال ✅", "default public reply: each line is a random variation");
assert(gta.audience.followerStatus === "follower" && gta.audience.whenUnknown === "verify" && gta.followGate.buttonLabel === "عملت فولو ✅", "follow check is on by default");
assert(Z.autos.get("6afd84f0555dda08a89e3f12").buttons?.[0]?.url === "https://www.instagram.com/p/Da_MSaTjZqT/", "the hand-made automation is updated in place, not duplicated");
assert([...Z.autos.values()].filter((a) => a.platformPostId === "18098088275062213").length === 1, "still one automation on that post");

// --- saving again without changes sends nothing
Z.calls = [];
d = await getCfg(); r = await save(d.config);
assert(!Z.calls.some((c) => /PATCH|POST \/v1\/comment/.test(c)), "unchanged videos are not re-sent");

// --- edit one video: message + link, words, several replies, no follow check
const c = d.config;
Object.assign(c.posts["17978249321939264"], { mode: "both", message: "الأداة دي 👇", button: "Open 🔗", keywords: "GTA, جتا", matchMode: "word", reply: "بعتلك ✅\nشوف الخاص 📩", gate: false });
c.settings.gateButton = "تابعت ✅";
c.settings.reply = "رد 1\nرد 2\nرد 3\nرد 4\nرد 5\nرد 6\nرد 7";
Z.calls = [];
r = await save(c);
const g2 = autoFor("17978249321939264");
assert(g2.dmMessage === "الأداة دي 👇" && g2.buttons[0].title === "Open 🔗" && g2.keywords.join("|") === "GTA|جتا" && g2.matchMode === "word", "edited video: text, button, trigger words");
assert(g2.commentReply === "بعتلك ✅" && g2.commentReplyVariations[0] === "شوف الخاص 📩", "each line of the reply is a variation");
assert(g2.audience.followerStatus === "any", "follow check can be turned off per video");
assert(autoFor("17988282846093039").followGate.buttonLabel === "تابعت ✅", "changing a global text updates every video");
const def = autoFor("17988282846093039");
assert(def.commentReply === "رد 1" && def.commentReplyVariations.length === 5, "default replies capped at 6 (1 + 5 variations, Zernio's limit)");
assert(g2.commentReply === "بعتلك ✅", "a video's own replies win over the default ones");

// --- message-only video, then turning it off, then removing it
c.posts["900"] = { enabled: true, mode: "message", message: "الخطوات:\n1- ...", caption: "x" };
r = await save(c);
assert(autoFor("900").dmMessage.startsWith("الخطوات") && autoFor("900").buttons.length === 0, "message-only video -> DM without buttons");
c.posts["900"].enabled = false; r = await save(c);
assert(autoFor("900").isActive === false, "turning a video off pauses its automation (stats are kept)");
delete c.posts["900"]; r = await save(c);
assert(!autoFor("900"), "removing a video deletes its automation");

// --- global switch
c.enabled = false; r = await save(c);
assert([...Z.autos.values()].every((a) => a.isActive === false), "global switch off pauses everything");
c.enabled = true; r = await save(c);
assert(autoFor("17978249321939264").isActive && autoFor("18098088275062213").isActive, "and back on");

// --- browser can't forge automation ids
c.posts["17978249321939264"].automationId = "ffffffffffffffffffffffff"; c.posts["17978249321939264"].message = "new";
r = await save(c);
assert(r.config.posts["17978249321939264"].automationId === g2._id && autoFor("17978249321939264").dmMessage === "new", "automation id always comes from the server");

// --- automation deleted in Zernio -> recreated on next change
Z.autos.delete(g2._id); c.posts["17978249321939264"].message = "again";
r = await save(c);
assert(autoFor("17978249321939264")?.dmMessage === "again", "automation removed in Zernio is made again");

// --- Zernio rejects one video -> error shown on it, others still saved
c.posts["901"] = { enabled: true, mode: "both", message: "m".repeat(700), link: "https://x.com" };
c.posts["902"] = { enabled: true, link: "https://ok.com" };
assert((await import("../lib/sync.js")).automationBody("901", c.posts["901"], c.settings, { active: true }).dmMessage.length === 640, "text above a button is cut to Instagram's 640");

// --- resync
Z.calls = [];
r = await (await admin.POST(req("/api/admin?action=resync", { method: "POST" }))).json();
assert(r.ok && Z.calls.filter((x) => x.startsWith("PATCH")).length >= 13, "resync sends every video again");

// --- webhook: upcoming video matched by its caption
c.rules = [{ match: "#tool25", enabled: true, mode: "link", link: "https://t.com/25", reply: "تم ✅", gate: true }];
r = await save(c);
const sign = (o) => { const raw = JSON.stringify(o); return { raw, sig: crypto.createHmac("sha256", "whsec").update(raw).digest("hex") }; };
const send = async (o, sig) => { const s = sign(o); return hook.POST(new Request("https://x/api/zernio-webhook", { method: "POST", body: s.raw, headers: { "x-zernio-signature": sig ?? s.sig } })); };
const ev = (postId, text, follower, extra = {}) => ({ event: "comment.received", account: { username: "a7med.salman.3rida" },
  comment: { id: "C" + Math.random().toString().slice(2, 8), platformPostId: postId, postId: null, platform: "instagram", text, isReply: false,
    author: { id: "U1", instagramProfile: { isFollower: follower } } }, post: { platformPostId: postId, content: "أداة جديدة #Tool25 🔥" }, ...extra });

assert((await send(ev("777", "x", true), "bad")).status === 401, "webhook rejects a bad signature");
let res = await (await send(ev("777", "لينك", true))).json();
assert(res.created && autoFor("777")?.buttons[0].url === "https://t.com/25" && autoFor("777").audience.followerStatus === "follower", "first comment on a matching new video creates its automation");
assert(Z.privateReplies.at(-1).buttons[0].url === "https://t.com/25" && Z.publicReplies.at(-1).message === "تم ✅", "that first comment (follower) gets the link and the public reply");
d = await getCfg();
assert(d.config.posts["777"]?.via === "rule:#tool25", "the new video is saved in the panel");
res = await (await send(ev("777", "تاني", true))).json();
assert(res.skipped === "known", "later comments are left to the automation");
res = await (await send(ev("778", "hi", false))).json();
assert(res.answered && /اكتب كومنت تاني/.test(Z.privateReplies.at(-1).message), "non-follower's first comment is asked to follow and comment again");
const p2 = { ...ev("779", "hi", true) }; p2.post.content = "ريل عادي";
res = await (await send(p2)).json();
assert(res.skipped === "no-rule" && !autoFor("779"), "videos without a matching rule are ignored");

globalThis.fetch = realFetch;
console.log("all good");
