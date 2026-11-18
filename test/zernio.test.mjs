// Panel <-> Zernio sync and the upcoming-video webhook, against a fake Zernio API.
// Run: node --import ./test/register.mjs test/zernio.test.mjs
import crypto from "node:crypto";
process.env.VERIFY_TOKEN = "abc";
process.env.BLOB_READ_WRITE_TOKEN = "test";
process.env.ZERNIO_API_KEY = "zk";
process.env.ZERNIO_WEBHOOK_SECRET = "whsec";
delete process.env.IG_ACCESS_TOKEN;

const ACC = "6afd7f3a4a29a11a85dec5e5", PROF = "6afd7f1800e3468668318f56";
const Z = { postComments: {}, convs: [], convMsgs: {}, logs: [], autos: new Map(), calls: [], privateReplies: [], publicReplies: [], sent: [], followers: new Set(), seq: 0 };
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
  const lg = path.match(/^\/v1\/comment-automations\/(\w+)\/logs$/);
  if (lg) return Response.json({ success: true, logs: Z.logs.filter((l) => l.automationId === lg[1]) });
  const m = path.match(/^\/v1\/comment-automations\/(\w+)$/);
  if (m) {
    const a = Z.autos.get(m[1]);
    if (!a) return Response.json({ error: "not found" }, { status: 404 });
    if (method === "PATCH") { Object.assign(a, body); return Response.json({ success: true, automation: a }); }
    if (method === "DELETE") { Z.autos.delete(m[1]); return Response.json({ success: true }); }
  }
  if (path === "/v1/inbox/comments" && method === "GET") return Response.json({ data: [
    { id: "18098088275062213", content: "@thesevendogsfilm 🔥", permalink: "https://www.instagram.com/p/Da_MSaTjZqT/", picture: "pic", createdTime: "2026-07-19T20:10:28Z", commentCount: 7 },
    { id: "17978249321939264", content: "GTA 6 نازلة\r\nاكتب GTA في الكومنت وهبعتلك الأداة 📩", permalink: "https://www.instagram.com/reel/DfvN_5btSE2/", createdTime: "2026-11-14T21:55:44Z", commentCount: 1589 },
  ], pagination: { hasMore: true, nextCursor: "CUR" } });
  if (path === "/v1/analytics" && method === "GET") return Response.json({ overview: { lastSync: "2026-11-18T14:30:14Z" }, pagination: { page: 1, pages: 1 }, posts: [
    { _id: "z1", content: "اكتب FreeLLMAPI في الكومنت", publishedAt: "2026-11-18T13:16:02Z", mediaProductType: "REELS", platformPostUrl: "https://i/reel/a", thumbnailUrl: "t",
      platforms: [{ platform: "instagram", platformPostId: "18091667573283321" }], analytics: { views: 1154, reach: 506, likes: 12, comments: 36, shares: 6, saves: 28, engagementRate: 7.11, igReelsAvgWatchTime: 7811, reelsSkipRate: 34.6 } },
    { _id: "z2", content: "GTA", publishedAt: "2026-11-17T21:26:28Z", mediaProductType: "REELS", platforms: [{ platform: "instagram", platformPostId: "17901732075398544" }], analytics: { views: 9524, reach: 8092, likes: 173, engagementRate: 4.69 } }] });
  if (path === "/v1/analytics/daily-metrics") return Response.json({ dailyData: [{ date: new Date().toISOString().slice(0, 10), metrics: { views: 500, reach: 300, likes: 20 } }] });
  if (/^\/v1\/accounts\/\w+\/health$/.test(path)) return Response.json({ status: "healthy", username: "a7med", tokenStatus: { valid: true, expiresIn: "59 days" }, issues: [], inboundActivity: { lastCommentAt: new Date().toISOString() } });
  if (path === "/v1/webhooks/logs") return Response.json({ logs: Z.whLogs ?? [] });
  const pc = path.match(/^\/v1\/inbox\/comments\/(\w+)$/);
  if (pc && method === "GET") return Response.json({ comments: Z.postComments[pc[1]] ?? [], pagination: { hasMore: false } });
  if (path === "/v1/inbox/conversations" && method === "GET") return Response.json({ data: Z.convs, pagination: { hasMore: false } });
  const cmm = path.match(/^\/v1\/inbox\/conversations\/(\w+)\/messages$/);
  if (cmm && method === "GET") return Response.json({ messages: Z.convMsgs[cmm[1]] ?? [] });
  const fs = path.match(/^\/v1\/accounts\/\w+\/follow-status\/(\w+)$/);
  if (fs) return Response.json({ userId: fs[1], isFollower: Z.followers.has(fs[1]), refreshed: u.searchParams.get("refresh") === "true" });
  const sm = path.match(/^\/v1\/inbox\/conversations\/(\w+)\/messages$/);
  if (sm && method === "POST") { Z.sent.push({ conv: sm[1], ...body }); return Response.json({ success: true }); }
  const pr = path.match(/^\/v1\/inbox\/comments\/(\w+)\/(\w+)\/private-reply$/);
  if (pr) { Z.privateReplies.push({ postId: pr[1], commentId: pr[2], ...body }); return Response.json({ success: true }); }
  const pub = path.match(/^\/v1\/inbox\/comments\/(\w+)$/);
  if (pub && method === "POST") { Z.publicReplies.push({ postId: pub[1], ...body }); return Response.json({ success: true }); }
  throw new Error("unhandled zernio call " + method + " " + path);
};

const admin = await import("../api/admin.js");
const hook = await import("../api/zernio-webhook.js");
const assert = (c, msg) => { if (!c) { console.error("FAIL", msg); process.exit(1); } console.log("ok", msg); };
const { DEFAULT_SETTINGS } = await import("../lib/config.js");
const isOneOf = (text, setting) => DEFAULT_SETTINGS[setting].split("\n").includes(text);
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
assert(gta.isActive && gta.keywords.length === 0 && gta.dmMessage === "اتفضل اللينك 👇" && gta.dmMessageVariations.length === 5 && gta.commentReply === "بعتلك في الخاص 📩",
  "link video -> link text + default public reply");
assert(gta.buttons[0].type === "url" && gta.buttons[0].url === "https://github.com/mutonby/openshorts"
  && gta.audience.followerStatus === "follower" && gta.audience.whenUnknown === "skip" && !gta.followGate.notFollowingMessage,
  "default (link style): Zernio sends the real link only to known followers and stays silent for everyone else");
assert(gta.commentReplyVariations.length === 2 && gta.commentReplyVariations[1] === "تم الإرسال ✅", "default public reply: each line is a random variation");
Z.followers.add("U4");
let tapRes = await (await (await import("../api/zernio-webhook.js")).oldButton({ message: { platform: "instagram", direction: "incoming", sender: { id: "U4" } },
  conversation: { id: "CONVU4" }, metadata: { postbackPayload: "msg:17978249321939264" }, account: { username: "a" } })).json();
assert(tapRes.answered === "link" && isOneOf(Z.sent.at(-1).message, "linkDm") && Z.sent.at(-1).buttons[0].url === "https://github.com/mutonby/openshorts" && Z.sent.at(-1).buttons[0].type === "url",
  "a follower tapping that button gets the real link button");
tapRes = await (await (await import("../api/zernio-webhook.js")).oldButton({ message: { platform: "instagram", direction: "incoming", sender: { id: "U3" } },
  conversation: { id: "CONVU3" }, metadata: { postbackPayload: "msg:17978249321939264" }, account: { username: "a" } })).json();
assert(tapRes.answered === "follow-first" && Z.sent.at(-1).buttons.at(-1).payload === "msg:17978249321939264", "a non-follower gets «follow first» with the same button to try again");
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
c.settings.gateStyle = "follow";
c.settings.reply = "رد 1\nرد 2\nرد 3\nرد 4\nرد 5\nرد 6\nرد 7";
Z.calls = [];
r = await save(c);
const g2 = autoFor("17978249321939264");
assert(g2.dmMessage === "الأداة دي 👇" && g2.buttons[0].title === "Open 🔗" && g2.keywords.join("|") === "GTA|جتا" && g2.matchMode === "word", "edited video: text, button, trigger words");
assert(g2.commentReply === "بعتلك ✅" && g2.commentReplyVariations[0] === "شوف الخاص 📩", "each line of the reply is a variation");
assert(g2.audience.followerStatus === "any", "follow check can be turned off per video");
c.settings.gateStyle = "link"; c.posts["17978249321939264"].gate = true; await save(c);
const g3 = autoFor("17978249321939264");
const { tapFirstDm } = await import("../lib/sync.js");
const t3 = tapFirstDm("17978249321939264", c.posts["17978249321939264"], c.settings);
assert(g3.audience.whenUnknown === "skip" && isOneOf(t3.dmMessage, "firstDm") && t3.buttons[0].title === "Open 🔗" && t3.buttons[0].type === "postback",
  "link style: the webhook's first DM is the link text with the video's own button name (its message waits for the check)");
c.posts["17978249321939264"].gate = false;
c.settings.gateStyle = "follow"; await save(c);
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
assert(Z.privateReplies.at(-1).buttons[0].url.startsWith("https://x/api/go?m=777&") && Z.publicReplies.at(-1).message === "تم ✅", "that first comment (follower) gets the link and the public reply");
d = await getCfg();
assert(d.config.posts["777"]?.via === "rule:#tool25", "the new video is saved in the panel");
res = await (await send(ev("777", "تاني", true))).json();
assert(res.skipped === "known", "later comments are left to the automation");
res = await (await send(ev("778", "hi", false))).json();
assert(res.answered && Z.privateReplies.at(-1).buttons.at(-1).payload === "msg:778", "non-follower's first comment on a new video gets a button that checks the follow");
const p2 = { ...ev("779", "hi", true) }; p2.post.content = "ريل عادي";
res = await (await send(p2)).json();
assert(res.skipped === "no-rule" && !autoFor("779"), "videos without a matching rule are ignored");

// --- old viaSocket buttons (message.received)
const tap = (payload, { sender = "U9", standby = false, title = "Link" } = {}) => ({ event: "message.received", account: { username: "a7med.salman.3rida" },
  conversation: { id: "CONV" + sender }, message: { platform: "instagram", direction: "incoming", text: title, sender: { id: sender } },
  metadata: { postbackPayload: payload, postbackTitle: title, ...(standby ? { standby: true } : {}) } });
const IDM = "https://misterdownloadmanager.com/";
Z.sent = [];
res = await (await send(tap(IDM))).json();
assert(res.answered === "follow-first" && Z.sent[0].buttons.at(-1).payload === "msg:18103119482424684" && Z.sent[0].buttons.at(-1).type === "postback",
  "old Link tap from a non-follower -> «follow first» with a button that checks again");
res = await (await send(tap(IDM))).json();
assert(res.skipped === "double-tap" && Z.sent.length === 1, "a double tap gets one answer");
assert(Z.sent[0].buttons.at(-1).title === c.settings.gateButton, "the retry button is named «عملت فولو», not like the link");
res = await (await send(tap(IDM, { title: "عملت فولو ✅" }))).json();
assert(res.answered === "follow-first" && Z.sent.length === 2, "tapping «عملت فولو» right after «follow first» (still not following) gets «not following» again");
Z.followers.add("U8");
res = await (await send(tap(IDM, { sender: "U8" }))).json();
assert(res.answered === "link" && Z.sent.at(-1).buttons[0].url.startsWith("https://x/api/go?m=18103119482424684&") && Z.sent.at(-1).conv === "CONVU8", "follower tapping an old Link button gets the link");
c.posts["903"] = { enabled: true, mode: "both", message: "اقرا ده", link: "https://m.com", gate: false };
await save(c);
res = await (await send(tap("msg:903", { sender: "U7" }))).json();
assert(res.answered === "link" && Z.sent.at(-1).dmMessage === undefined && Z.sent.at(-1).message === "اقرا ده" && Z.sent.at(-1).buttons[0].url.startsWith("https://x/api/go?m=903&"),
  "old v2 button (msg:<id>) sends that video's current message + link; its follow check setting is respected");
assert((await (await send(tap(IDM, { sender: "U6", standby: true }))).json()).skipped === "standby", "standby taps are left alone");
assert((await (await send(tap("zernio_follow_gate:abc", { sender: "U5" }))).json()).skipped === "not-old-button", "Zernio's own buttons are not touched");
c.posts["17978249321939264"].enabled = false; await save(c);
assert((await (await send(tap("https://github.com/mutonby/openshorts", { sender: "U8" }))).json()).skipped === "video-off", "a video turned off in the panel stops its old buttons too");

// --- link style: comments on panel videos (webhook sends the first DM to anyone not known to follow)
c.settings.gateStyle = "link";
c.posts["904"] = { enabled: true, mode: "link", link: "https://z.com", button: "Zed", gate: true, keywords: "zed", matchMode: "word" };
await save(c);
hook.timing.tries = 2; hook.timing.waitMs = 1; hook.timing.answerWithinMs = 60_000;
const a904 = () => autoFor("904")._id;
const cm = (author, text, follower, cid = "K" + Math.random().toString().slice(2, 8)) => ({ event: "comment.received", account: { username: "a" },
  comment: { id: cid, platformPostId: "904", postId: null, platform: "instagram", text, isReply: false,
    author: { id: author, instagramProfile: { isFollower: follower } } }, post: { platformPostId: "904", content: "x" } });
const before = Z.privateReplies.length;
res = await (await send(cm("A1", "عايز Zed لو سمحت", null))).json();
assert(res.answered === "tap-first" && Z.privateReplies.at(-1).buttons[0].type === "postback" && Z.privateReplies.at(-1).buttons[0].payload === "msg:904"
  && Z.privateReplies.at(-1).buttons[0].title === "Zed" && isOneOf(Z.privateReplies.at(-1).message, "firstDm"), "unknown commenter gets the check DM (its own text) with a tap button");
assert(Z.publicReplies.at(-1).commentId === Z.privateReplies.at(-1).commentId, "…and the public reply");
res = await (await send(cm("A2", "zed", false))).json();
assert(res.answered === "tap-first", "known non-follower also gets the link-looking DM (not «not following»)");
Z.logs.push({ automationId: a904(), commentId: "CA3", status: "sent" });
res = await (await send(cm("A3", "zed", true, "CA3"))).json();
assert(res.skipped === "zernio-sent" && Z.privateReplies.length === before + 2, "a comment Zernio answered (follower) is left alone");
Z.logs.push({ automationId: a904(), commentId: "CA6", status: "skipped", error: "Audience rule: not_follower", audienceOutcome: "blocked" });
res = await (await send(cm("A6", "zed", true, "CA6"))).json();
assert(res.answered === "tap-first", "webhook says follower but Zernio blocked it (stale info) -> the link-looking DM still goes out");
Z.logs.push({ automationId: a904(), commentId: "CA7", status: "skipped", error: "Already sent DM to this commenter" });
res = await (await send(cm("A7", "zed", true, "CA7"))).json();
assert(res.skipped === "zernio-repeat", "someone Zernio already sent the link to is not messaged again");
res = await (await send(cm("A1", "zed again", null))).json();
assert(res.answered === "tap-first", "default: the same person commenting again is answered again");
c.settings.repeat = "once"; await save(c);
assert(autoFor("904").repeatPolicy.mode === "once", "«first comment only» setting reaches Zernio");
res = await (await send(cm("A1", "zed third", null))).json();
assert(res.skipped === "already-answered", "with «first comment only» the same person gets one DM");
c.settings.repeat = "every"; await save(c);
assert(autoFor("904").repeatPolicy.mode === "every_comment", "default repeat policy is every comment");
res = await (await send(cm("A4", "zedd", null))).json();
assert(res.skipped === "no-keyword", "trigger words are respected (word match)");
c.posts["904"].gate = false; await save(c);
res = await (await send(cm("A5", "zed", null))).json();
assert(res.skipped === "known", "follow check off: Zernio sends the link to everyone, webhook stays out");

// --- «answer what was missed»: comments on one video
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
c.posts["905"] = { enabled: true, mode: "link", link: "https://five.com", button: "Five", gate: true, keywords: "five" };
await save(c);
Z.followers.add("F1");
Z.postComments["905"] = [
  { id: "B1", message: "five please", createdTime: ago(2), from: { id: "F1", username: "fan" }, replies: [] },                       // follower -> link
  { id: "B2", message: "five", createdTime: ago(3), from: { id: "N1", username: "new" }, replies: [] },                              // unknown -> first DM
  { id: "B3", message: "five", createdTime: ago(4), from: { id: "N2" }, replies: [{ from: { id: "x", isOwner: true }, message: "تم" }] }, // already answered
  { id: "B4", message: "five", createdTime: ago(24 * 8), from: { id: "N3" }, replies: [] },                                         // > 7 days
  { id: "B5", message: "hello", createdTime: ago(1), from: { id: "N4" }, replies: [] },                                             // no keyword
  { id: "B6", message: "five", createdTime: ago(1), from: { id: "N5" }, replies: [] },                                              // Zernio already sent
  { id: "B7", message: "me", createdTime: ago(1), from: { id: "own", isOwner: true }, replies: [] },
];
Z.logs.push({ automationId: autoFor("905")._id, commentId: "B6", status: "sent" });
const bf = async (qs) => (await admin.POST(req("/api/admin?" + qs, { method: "POST" }))).json();
const prBefore = Z.privateReplies.length;
let b = await bf("action=backfill&id=905");
assert(b.answered === 2 && b.links === 1 && b.firsts === 1 && b.alreadyDone === 2 && b.tooOld === 1 && b.noKeyword === 1 && b.remaining === 0,
  "backfill answers only the missed comments (skips answered, too old, no keyword, Zernio-sent)");
const newPR = Z.privateReplies.slice(prBefore);
assert(newPR.find((x) => x.commentId === "B1").buttons[0].url.includes("/api/go?m=905&") && newPR.find((x) => x.commentId === "B2").buttons[0].payload === "msg:905",
  "follower gets the (tracked) link, unknown gets the check button");
assert((await bf("action=backfill&id=999")).error, "backfill refuses a video that isn't in the panel");

// --- keyword in DMs
c.posts["905"].dmKeywords = true; await save(c);
const dmEv = (sender, text, extra = {}) => ({ event: "message.received", account: { username: "me" }, conversation: { id: "CV" + sender },
  message: { platform: "instagram", direction: "incoming", text, sender: { id: sender } }, metadata: {}, ...extra });
Z.sent = [];
res = await (await send(dmEv("F1", "ممكن five"))).json();
assert(res.answered === "link" && res.video === "905" && Z.sent.at(-1).buttons[0].url.includes("/api/go?m=905&"), "a follower who DMs the word gets the link");
res = await (await send(dmEv("N9", "five"))).json();
assert(res.answered === "follow-first" && Z.sent.at(-1).buttons.at(-1).payload === "msg:905", "a non-follower who DMs the word gets «follow first»");
assert((await (await send(dmEv("N8", "hello"))).json()).skipped === "no-keyword", "other DMs are ignored");
assert((await (await send(dmEv("N7", "five", { metadata: { standby: true } }))).json()).skipped === "standby", "a DM in a chat another app holds is left alone");
c.posts["905"].dmKeywords = false; c.settings.dmAll = false; await save(c);
assert((await (await send(dmEv("F1", "five"))).json()).skipped === "no-keyword", "with the global DM switch off, the per-video switch decides");
c.settings.dmAll = true; await save(c);
assert((await (await send(dmEv("F2", "five"))).json()).video === "905", "global DM switch (default on) answers every video's word");
const { captionKeyword } = await import("../lib/autokw.js");
assert(captionKeyword("بديل IDM\r\nاكتب IDM في الكومنت وهبعتلك") === "IDM" && captionKeyword("🎁 اكتب ALGO في الكومنت") === "ALGO" && captionKeyword("ريل عادي") === "", "the word is read from «اكتب X في الكومنت»");
c.posts["17978249321939264"].enabled = true; c.posts["17978249321939264"].keywords = ""; await save(c);
Z.followers.add("G1");
res = await (await send(dmEv("G1", "Gta"))).json();
assert(res.video === "17978249321939264" && res.answered === "link", "a video with no trigger words answers the word from its caption in DMs (any case)");
assert((await (await send(dmEv("G2", "gtaaa"))).json()).skipped === "no-keyword", "a caption word matches as a whole word only");
c.posts["905"].dmKeywords = true; await save(c);

// --- «answer what was missed»: DMs
Z.convs = [
  { id: "V1", participantId: "F1", participantUsername: "fan", accountUsername: "me", updatedTime: ago(1) },
  { id: "V2", participantId: "N1", participantUsername: "x", accountUsername: "me", updatedTime: ago(2) },
  { id: "V3", participantId: "N2", accountUsername: "me", updatedTime: ago(3) },
  { id: "V4", participantId: "N3", accountUsername: "me", updatedTime: ago(30) },
];
Z.convMsgs = {
  V1: [{ direction: "incoming", message: "five?", senderId: "F1", createdAt: ago(1) }],
  V2: [{ direction: "outgoing", message: "done", createdAt: ago(1.5) }, { direction: "incoming", message: "five", createdAt: ago(2) }],
  V3: [{ direction: "incoming", message: "thanks", senderId: "N2", createdAt: ago(3) }],
  V4: [{ direction: "incoming", message: "five", senderId: "N3", createdAt: ago(30) }],
};
Z.sent = [];
b = await bf("action=backfill-dms");
assert(b.answered === 1 && b.links === 1 && Z.sent.length === 1 && Z.sent[0].conv === "V1", "DM backfill answers unanswered keyword DMs inside 24h only");

// --- tracked link
const go = await import("../api/go.js");
const link = Z.sent[0].buttons[0].url;
const r1 = await go.GET(new Request(link));
assert(r1.status === 302 && r1.headers.get("location") === "https://five.com", "tracked link redirects to the video's link");
assert((await go.GET(new Request(link.replace(/s=\w+/, "s=0000000000000000")))).status === 404, "a forged tracked link is refused");

// --- stats
const st = await (await admin.GET(req("/api/admin?action=stats&days=7"))).json();
const v905 = st.top.find((x) => x.id === "905");
assert(st.daily.length === 7 && v905 && v905.clicks >= 1 && v905.links >= 2 && st.totals.answered > 0, "stats: per video and per day");
assert(typeof st.totals.followRate === "number", "stats: follow rate after the check");

// --- slow work is finished after answering Zernio (no webhook timeout)
c.settings.gateStyle = "link"; c.posts["905"].gate = true; c.posts["905"].enabled = true; await save(c);
hook.timing.answerWithinMs = 1; hook.timing.waitMs = 30;
const prSlow = Z.privateReplies.length;
const slowEv = cm("S1", "five", null, "CS" + (Date.now() % 100000)); slowEv.comment.platformPostId = "905"; slowEv.post.platformPostId = "905";
res = await (await send(slowEv)).json();
assert(res.queued === true, "a slow comment answer returns «queued» to Zernio right away");
await new Promise((r) => setTimeout(r, 300));
assert(Z.privateReplies.length === prSlow + 1, "…and the DM still goes out in the background");
assert((await (await send(dmEv("N7", "five", { metadata: { standby: true } }))).json()).skipped === "standby", "quick answers (standby) are still returned as they are");
hook.timing.answerWithinMs = 60_000; hook.timing.waitMs = 1;

const { cleanSettings } = await import("../lib/config.js");
const up = cleanSettings({ linkDm: "اتفضل اللينك 👇", firstDm: "نص بتاعي" });
assert(up.linkDm.split("\n").length === 6 && up.firstDm.split("\n")[0] === "نص بتاعي" && up.firstDm.split("\n").length === 6 && up.textsV2,
  "one-time upgrade: a single saved text stays first and gets 5 more");
assert(cleanSettings({ ...up, firstDm: "نص واحد بس" }).firstDm === "نص واحد بس", "after the upgrade, a single text chosen later stays single");

// --- several texts for the first DM and the link DM
c.settings.linkDm = "اتفضل اللينك 👇\nاللينك أهو 🔗\nدوس على الزرار 👇";
c.settings.firstDm = "دوس على الزرار تحت 👇\nاضغط تحت وهوصلك 👇";
c.posts["905"].dmKeywords = false; c.posts["905"].gate = true; c.posts["905"].mode = "link";
await save(c);
const a905 = autoFor("905");
assert(a905.dmMessage === "اتفضل اللينك 👇" && a905.dmMessageVariations.join("|") === "اللينك أهو 🔗|دوس على الزرار 👇" && a905.followGate.message === "دوس على الزرار تحت 👇",
  "Zernio gets the first «لينك» text + the others as variations");
const sync2 = await import("../lib/sync.js");
const seenFirst = new Set(), seenLink = new Set();
for (let i = 0; i < 60; i++) { seenFirst.add(sync2.tapFirstDm("905", c.posts["905"], c.settings).dmMessage); seenLink.add(sync2.dmFor(c.posts["905"], c.settings).dmMessage); }
assert(seenFirst.size === 2 && seenLink.size === 3, "the panel picks a random text for the first DM and the link DM");

// --- system status
Z.whLogs = [
  { event: "message.received", status: "success", createdAt: new Date().toISOString(), responseBody: '{"ok":true,"skipped":"standby"}',
    requestPayload: { message: { sender: { username: "hossein" } }, metadata: { postbackTitle: "MDM" } } },
  { event: "comment.received", status: "success", createdAt: new Date().toISOString(), responseBody: '{"ok":true}' },
  { event: "comment.received", status: "failed", createdAt: new Date().toISOString(), errorMessage: "The operation was aborted" },
];
const hs = await (await admin.GET(req("/api/admin?action=health"))).json();
const ck = (k) => hs.checks.find((x) => x.key === k);
assert(ck("zernio").level === "green" && ck("webhook").level === "red" && ck("lost").level === "red" && hs.lost[0].user === "hossein" && hs.level === "red",
  "status page: account ok, webhook failures and lost taps are flagged, with who was lost");

// --- video stats
const vs = await (await admin.GET(req("/api/admin?action=videostats&days=7"))).json();
assert(vs.posts.length === 2 && vs.posts[0].id === "18091667573283321" && vs.posts[0].views === 1154 && vs.posts[0].avgWatch === 7.8 && vs.totals.views === 10678,
  "video stats: per video views, reach, likes… and totals");
assert(vs.daily.length === 7 && vs.daily.at(-1).views === 500, "video stats: account views per day");

globalThis.fetch = realFetch;
console.log("all good");
