// Local test: simulates a Meta webhook without calling Instagram.
process.env.DOWNLOAD_LINK = "https://example.com/tool";
process.env.VERIFY_TOKEN = "abc";
const calls = [];
globalThis.fetch = async (url, opts) => { calls.push([url, JSON.parse(opts.body)]); return new Response("{}", { status: 200 }); };
const { GET, POST, matchesKeyword } = await import("./api/webhook.js");
const assert = (c, m) => { if (!c) { console.error("FAIL", m); process.exit(1); } console.log("ok", m); };

assert(matchesKeyword("عايز التحميل لو سمحت"), "keyword inside sentence");
assert(matchesKeyword("تحميلل") && !matchesKeyword("شكرا"), "match / no match");
assert((await (await GET(new Request("https://x/api/webhook?hub.mode=subscribe&hub.verify_token=abc&hub.challenge=42"))).text()) === "42", "verify handshake");
assert((await GET(new Request("https://x/api/webhook?hub.mode=subscribe&hub.verify_token=no&hub.challenge=42"))).status === 403, "bad verify token");

const ev = (fromId, text) => new Request("https://x/api/webhook", { method: "POST", body: JSON.stringify({
  entry: [{ id: "OWNER", changes: [{ field: "comments", value: { id: "C1", text, from: { id: fromId, username: "ahmed" }, media: { id: "M1" } } }] }] }) });
await POST(ev("U1", "تحميل"));
assert(calls.length === 2, "two API calls for matching comment");
assert(calls[0][0].endsWith("/me/messages") && calls[0][1].recipient.comment_id === "C1" && calls[0][1].message.text.includes("https://example.com/tool"), "DM has link");
assert(calls[1][0].endsWith("/C1/replies"), "public reply");
calls.length = 0;
await POST(ev("OWNER", "تحميل"));
await POST(ev("U2", "حلو الفيديو"));
assert(calls.length === 0, "ignores own comments and non-keyword comments");

// Per-video rules
const { findRule } = await import("./api/webhook.js");
const R = [
  { keyword: "تحميل", link: "L1" },
  { keyword: "كورس", link: "L2", dm: "خد يا {username}: {link}" },
  { keyword: "تحميل", link: "L3", media: "M9" },
];
assert(findRule("عايز كورس", "M1", R).link === "L2", "picks rule by keyword");
assert(findRule("تحميل", "M9", R).link === "L3", "post-specific rule wins");
assert(findRule("تحميل", "M1", R).link === "L1", "general rule on other posts");
assert(findRule("شكرا", "M1", R) === null, "no rule");
