// Local test: simulates Meta webhooks + the settings API without calling Instagram or real storage.
// Needs a stub for @vercel/blob on NODE_PATH-like resolution (see README) or the real package installed.
process.env.VERIFY_TOKEN = "abc";
process.env.BLOB_READ_WRITE_TOKEN = "test";
const calls = [];
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
const media = await (await admin.GET(req("/api/admin?action=media"))).json();
assert(media.items[0].id === "M1" && media.items[0].type === "REEL", "admin lists posts");
const saveRes = await admin.POST(req("/api/admin", { method: "POST", body: JSON.stringify({
  enabled: true, defaultDm: "يا {username}: {link}", defaultReply: "بعتلك ❤️",
  posts: { "111": { enabled: true, link: "https://a.com/1" }, "222": { enabled: true, link: "https://b.com/2", keyword: "لينك", dm: "خاص {link}" }, "333": { enabled: false, link: "https://c.com" } },
}) }));
assert(saveRes.status === 200, "admin saves settings");
const cfg = (await (await admin.GET(req("/api/admin?action=config"))).json()).config;
assert(cfg.posts["222"].link === "https://b.com/2", "settings read back");

const ev = (fromId, text, media) => new Request("https://x/api/webhook", { method: "POST", body: JSON.stringify({
  entry: [{ id: "OWNER", changes: [{ field: "comments", value: { id: "C1", text, from: { id: fromId, username: "ahmed" }, media: { id: media } } }] }] }) });

calls.length = 0;
await POST(ev("U1", "حلو جدا", "111"));
assert(calls.length === 2 && calls[0][1].message.text === "يا ahmed: https://a.com/1", "any comment on post 111 gets its own link");
assert(calls[1][0].endsWith("/C1/replies") && calls[1][1].message === "بعتلك ❤️", "public reply");

calls.length = 0;
await POST(ev("U1", "ابعت لينك", "222"));
assert(calls.length === 2 && calls[0][1].message.text === "خاص https://b.com/2", "post 222 uses its own link + custom DM");
calls.length = 0;
await POST(ev("U1", "حلو", "222"));
assert(calls.length === 0, "post with keyword ignores other comments");

calls.length = 0;
await POST(ev("U1", "حلو", "333"));
await POST(ev("U1", "حلو", "999"));
await POST(ev("OWNER", "حلو", "111"));
assert(calls.length === 0, "ignores disabled posts, unconfigured posts and own comments");

const off = await handleComment({ id: "C2", text: "x", from: { id: "U9" }, media: { id: "111" } }, "OWNER", { ...cfg, enabled: false });
assert(off === "disabled", "global switch off");
globalThis.fetch = realFetch;
