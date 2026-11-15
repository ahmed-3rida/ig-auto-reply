// Local test for the panel API and the link lookup that viaSocket uses.
// Needs @vercel/blob (npm install) — or a stub of it — to run.
process.env.VERIFY_TOKEN = "abc";
process.env.BLOB_READ_WRITE_TOKEN = "test";
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  url = String(url);
  if (url.startsWith("https://blob.test/")) return new Response(globalThis.__blobs.find((x) => x.url === url).body, { status: 200 });
  if (url.includes("/me/media")) {
    return Response.json({ data: [{ id: "M1", caption: "ريل 1", media_type: "VIDEO", media_product_type: "REELS", thumbnail_url: "t", permalink: "p", timestamp: "2026-11-01T00:00:00+0000" }], paging: {} });
  }
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

await save({ ...cfg, enabled: false });
assert(!(await lk("111")).found, "global switch off stops all links");
globalThis.fetch = realFetch;
