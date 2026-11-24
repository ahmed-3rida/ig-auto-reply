// Hourly cap on private replies: above it a comment waits in Supabase and goes out later.
// Run: node --import ./test/register.mjs test/quota.test.mjs
import crypto from "node:crypto";
process.env.VERIFY_TOKEN = "abc";
process.env.ZERNIO_API_KEY = "zk";
process.env.ZERNIO_WEBHOOK_SECRET = "whsec";
process.env.SUPABASE_URL = "https://sb.test";
process.env.SUPABASE_SECRET_KEY = "sb_secret_x";
process.env.PRIVATE_REPLIES_PER_HOUR = "2";
delete process.env.BLOB_READ_WRITE_TOKEN;

const VID = "18091667573283321";
const DB = { events: [], pending: [] };
const Z = { private: [], public: [] };
const row = { enabled: true, settings: {}, rules: [], posts: { [VID]: { enabled: true, mode: "link", link: "https://x.y", button: "X", gate: true, keywords: "", automationId: "a".repeat(24) } } };

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const u = new URL(url), method = init.method ?? "GET", body = init.body ? JSON.parse(init.body) : null;
  if (u.origin === "https://sb.test") {
    const table = u.pathname.replace("/rest/v1/", "");
    if (table === "app_config") return method === "GET" ? Response.json([{ data: row }]) : new Response(null, { status: 201 });
    if (table === "events" && method === "POST") { DB.events.push(body); return new Response(null, { status: 201 }); }
    if (table === "events" && method === "HEAD") {
      const since = u.searchParams.get("at").replace("gte.", ""), type = u.searchParams.get("type").replace("eq.", "");
      const n = DB.events.filter((e) => e.type === type && e.at >= since).length;
      return new Response(null, { status: 206, headers: { "content-range": `0-0/${n}` } });
    }
    if (table === "pending_replies") {
      if (method === "HEAD") return new Response(null, { status: 206, headers: { "content-range": `0-0/${DB.pending.length}` } });
      if (method === "POST") { if (!DB.pending.some((p) => p.comment_id === body.comment_id)) DB.pending.push({ ...body, queued_at: new Date().toISOString() }); return new Response(null, { status: 201 }); }
      if (method === "GET") return Response.json(DB.pending.slice(0, Number(u.searchParams.get("limit"))).map((p) => ({ comment_id: p.comment_id })));
      if (method === "DELETE") {
        const id = u.searchParams.get("comment_id").replace("eq.", ""), hit = DB.pending.filter((p) => p.comment_id === id);
        DB.pending = DB.pending.filter((p) => p.comment_id !== id);
        return Response.json(hit);
      }
    }
    return Response.json([]);
  }
  const path = u.pathname.replace(/^\/api/, "");
  if (path === "/v1/accounts") return Response.json({ accounts: [{ _id: "b".repeat(24), platform: "instagram", profileId: "c".repeat(24) }] });
  const pr = path.match(/^\/v1\/inbox\/comments\/(\w+)\/(\w+)\/private-reply$/);
  if (pr && Z.billing) return Response.json({ error: { message: "Monthly free message allowance reached. Add a payment method to keep sending, or wait until next month." } }, { status: 402 });
  if (pr) { Z.private.push(pr[2]); return Response.json({ success: true }); }
  if (/^\/v1\/inbox\/comments\/\w+$/.test(path) && method === "POST") { Z.public.push(body.commentId); return Response.json({ success: true }); }
  if (/\/logs$/.test(path)) return Response.json({ logs: [] });
  throw new Error("unhandled " + method + " " + path);
};

const assert = (c, msg) => { if (!c) { console.error("FAIL", msg); process.exit(1); } console.log("ok", msg); };
const hook = await import("../api/zernio-webhook.js");
hook.timing.answerWithinMs = 60_000;
const sign = (raw) => crypto.createHmac("sha256", "whsec").update(raw).digest("hex");
const comment = async (id) => {
  const raw = JSON.stringify({ event: "comment.received", comment: { id, platform: "instagram", platformPostId: VID, text: "FreeLLMAPI", author: { id: "u" + id }, createdAt: new Date().toISOString() } });
  return (await hook.POST(new Request("https://x/api/zernio-webhook", { method: "POST", body: raw, headers: { "x-zernio-signature": sign(raw) } }))).json();
};

let a = await comment("C1"), b = await comment("C2"), c = await comment("C3");
assert(a.answered && b.answered && Z.private.length === 2, "first two comments answered (cap = 2 an hour)");
assert(c.deferred === "hourly-cap" && DB.pending.length === 1 && DB.pending[0].comment_id === "C3" && !Z.private.includes("C3"), "third one waits in the queue instead of being sent");
assert(DB.events.filter((e) => e.type === "pr").length === 2, "each private reply counted");

// an hour later: there is room again, the queue goes out by itself
for (const e of DB.events) e.at = new Date(Date.now() - 3700e3).toISOString();
const sent = await hook.drainQueue("https://x", { force: true });
assert(sent === 1 && Z.private.includes("C3") && DB.pending.length === 0 && Z.public.includes("C3"), "queued comment answered once there is room (DM + public reply)");

// Zernio's monthly free messages used up: the comment waits instead of being lost, and goes out once sending works
Z.billing = true;
const d = await comment("C4");
assert(d.deferred === "zernio-allowance" && DB.pending.some((p) => p.comment_id === "C4") && !Z.private.includes("C4"), "allowance used up -> comment queued, not lost");
assert(await hook.drainQueue("https://x", { force: true }) === 0 && DB.pending.some((p) => p.comment_id === "C4"), "still blocked -> stays in the queue");
Z.billing = false;
assert(await hook.drainQueue("https://x", { force: true }) === 1 && Z.private.includes("C4") && DB.pending.length === 0, "payment added -> queued comment answered");
console.log("all quota tests passed");
