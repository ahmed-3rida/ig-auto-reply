// Local test for the panel API and the link lookup that viaSocket uses.
// Needs @vercel/blob (npm install) — or a stub of it — to run.
process.env.VERIFY_TOKEN = "abc";
process.env.BLOB_READ_WRITE_TOKEN = "test";
process.env.IG_ACCESS_TOKEN = "tok";
const CAPTIONS = { "555": "أداة جديدة للتحميل 🔥 #Tool25 جربها", "556": "ريل عادي", "557": "#tool25 و #tool25pro" };
let CAPTION_CALLS = 0;
const ago = (sec) => new Date(Date.now() - sec * 1000).toISOString();
const CONVS = {
  "10001": [{ created_time: ago(5), from: { id: "10001" }, message: "Link" }],                                   // never answered
  "10002": [{ created_time: ago(3600), from: { id: "OWN" }, message: "Here's the link 👇" }],                  // got link 1h ago
  "10003": [{ created_time: ago(3600), from: { id: "OWN" }, message: "Follow first 🙏 then tap Following 👇" }], // only asked to follow
  "10004": [{ created_time: ago(5), from: { id: "OWN" }, message: "" }],                                       // replied 5s ago
  "10007": [{ created_time: ago(4), from: { id: "OWN" }, message: "Follow first 🙏 then tap Following 👇" }], // just asked, then followed fast
  "10005": [{ created_time: ago(90000), from: { id: "OWN" }, message: "Here's the link 👇" }],                 // link 25h ago
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  url = String(url);
  if (url.startsWith("https://blob.test/")) return new Response(globalThis.__blobs.find((x) => x.url === url).body, { status: 200 });
  if (url.includes("/me/media")) {
    return Response.json({ data: [{ id: "M1", caption: "ريل 1", media_type: "VIDEO", media_product_type: "REELS", thumbnail_url: "t", permalink: "p", timestamp: "2026-11-01T00:00:00+0000" }], paging: {} });
  }
  if (url.includes("/me/conversations")) {
    const user = new URL(url).searchParams.get("user_id");
    return Response.json({ data: CONVS[user] ? [{ id: "c" + user, messages: { data: CONVS[user] } }] : [] });
  }
  const cap = url.match(/\/(\d+)\?fields=caption/);
  if (cap) { CAPTION_CALLS++; return Response.json({ id: cap[1], caption: CAPTIONS[cap[1]] ?? "" }); }
  throw new Error("unexpected fetch " + url);
};
const admin = await import("./api/admin.js");
const linkApi = await import("./api/link.js");
const assert = (c, m) => { if (!c) { console.error("FAIL", m); process.exit(1); } console.log("ok", m); };
const req = (path, init = {}, key = "abc") => new Request("https://x" + path, { ...init, headers: { "x-admin-key": key, "content-type": "application/json" } });
const lk = async (id) => (await linkApi.GET(new Request("https://x/api/link?media_id=" + id))).json();

assert((await admin.GET(req("/api/admin?action=config", {}, "wrong"))).status === 401, "panel rejects wrong password");
const first = (await (await admin.GET(req("/api/admin?action=config"))).json()).config;
assert(first.posts["17978249321939264"].link === "https://github.com/mutonby/openshorts", "old viaSocket videos are there by default");
const media = await (await admin.GET(req("/api/admin?action=media"))).json();
assert(media.items[0].id === "M1" && media.items[0].type === "REEL", "panel lists posts");

const save = (cfg) => admin.POST(req("/api/admin", { method: "POST", body: JSON.stringify(cfg) }));
assert((await save({ enabled: true, posts: {
  "111": { enabled: true, link: "https://a.com/1" },
  "333": { enabled: false, link: "https://c.com" },
  "17978249321939264": { enabled: false, link: "https://github.com/mutonby/openshorts" },
  "abc": { enabled: true, link: "https://x" },
}, junk: 1 })).status === 200, "panel saves");
const cfg = (await (await admin.GET(req("/api/admin?action=config"))).json()).config;
assert(cfg.posts["111"].link === "https://a.com/1" && !cfg.posts.abc && !("junk" in cfg), "saved settings are cleaned");

assert((await lk("111")).found && (await lk("111")).link === "https://a.com/1", "lookup returns the video link");
assert(!(await lk("333")).found, "turned-off video returns nothing");
assert(!(await lk("17978249321939264")).found, "old video can be turned off from the panel");
assert((await lk("17977825794155993")).found, "other old videos keep working");
assert(!(await lk("999")).found, "unknown video returns nothing");
assert((await linkApi.GET(new Request("https://x/api/link?media_id=x"))).status === 400, "bad media_id rejected");

// Scheduled / upcoming videos: matched by a phrase in the caption
await save({ ...cfg, rules: [
  { match: "#TOOL25", link: "https://t.com/25", enabled: true },
  { match: "#tool25pro", link: "https://t.com/pro", enabled: true },
  { match: "ريل", link: "https://t.com/off", enabled: false },
  { match: "", link: "https://x.com" },
] });
const c2 = (await (await admin.GET(req("/api/admin?action=config"))).json()).config;
assert(c2.rules.length === 3, "empty rules are dropped");
const r555 = await lk("555");
assert(r555.found && r555.link === "https://t.com/25" && r555.via === "caption", "upcoming video gets its link from the caption (case-insensitive)");
assert((await lk("557")).link === "https://t.com/pro", "longest matching phrase wins");
assert(!(await lk("556")).found, "turned-off rule is ignored");
assert(!(await lk("333")).found, "a video turned off in the panel is not overridden by a rule");
const before = CAPTION_CALLS; await lk("555");
assert(CAPTION_CALLS === before, "captions are cached");

// Repeated taps on Link / Following
const sr = await import("./api/should-reply.js");
const ask = async (user, kind) => (await sr.GET(new Request(`https://x/api/should-reply?user=${user}&kind=${kind}`))).json();
assert((await ask("10001", "link")).reply === true, "first tap gets the link");
assert((await ask("10001", "link")).reply === false, "a second tap at the same moment is blocked");
assert((await ask("10002", "link")).reason === "link-already-sent", "link already sent today -> no repeat");
assert((await ask("10003", "link")).reply === true, "after 'follow first' the follower still gets the link");
assert((await ask("10004", "link")).reason === "replied-seconds-ago", "rapid taps blocked");
assert((await ask("10004", "ask")).reason === "asked-seconds-ago", "rapid 'follow first' repeats blocked");
assert((await ask("10007", "link")).reply === true, "following right after 'follow first' still works");
assert((await ask("10005", "link")).reply === true, "after 24h they can get it again");
assert((await ask("10006", "ask")).reply === true, "new person asked to follow");
assert((await sr.GET(new Request("https://x/api/should-reply?user=abc"))).status === 400, "bad user rejected");

await save({ ...cfg, enabled: false });
assert(!(await lk("111")).found, "global switch off stops all links");
globalThis.fetch = realFetch;
