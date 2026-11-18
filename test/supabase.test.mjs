// Settings and events on Supabase (fake PostgREST + fake Zernio).
// Run: node --import ./test/register.mjs test/supabase.test.mjs
process.env.VERIFY_TOKEN = "abc";
process.env.SUPABASE_URL = "https://sb.test";
process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
process.env.ZERNIO_API_KEY = "zk";
delete process.env.BLOB_READ_WRITE_TOKEN;

const DB = { app_config: [], events: [] }, calls = [];
const AUTO = { _id: "a".repeat(24), platformPostId: "777", trigger: "comment", isActive: true, keywords: [], dmMessage: "اللينك أهو 👇",
  dmMessageVariations: ["خد اللينك"], buttons: [{ type: "url", url: "https://seven.com", title: "Seven" }], commentReply: "تم",
  audience: { followerStatus: "follower", whenUnknown: "skip" }, followGate: { message: "دوس هنا 👇" }, repeatPolicy: { mode: "every_comment" }, stats: {} };
globalThis.fetch = async (url, init = {}) => {
  url = String(url); const u = new URL(url), method = init.method ?? "GET", body = init.body ? JSON.parse(init.body) : null;
  if (u.origin === "https://sb.test") {
    calls.push(method + " " + u.pathname);
    if (init.headers?.apikey !== "sb_secret_test") return new Response("no key", { status: 401 });
    const table = u.pathname.replace("/rest/v1/", "");
    if (table === "app_config" && method === "GET") return Response.json(DB.app_config.filter((r) => r.id === "main").map((r) => ({ data: r.data })));
    if (table === "app_config" && method === "POST") { DB.app_config = DB.app_config.filter((r) => r.id !== body.id).concat(body); return new Response(null, { status: 201 }); }
    if (table === "events" && method === "POST") { DB.events.push({ ...body }); return new Response(null, { status: 201 }); }
    if (table === "events" && method === "GET") {
      const since = u.searchParams.get("at").replace("gte.", ""), [from, to] = init.headers.Range.split("-").map(Number);
      return Response.json(DB.events.filter((e) => e.at >= since).sort((a, b) => a.at.localeCompare(b.at)).slice(from, to + 1));
    }
  }
  if (u.origin === "https://zernio.com") {
    const path = u.pathname.replace(/^\/api/, "");
    if (path === "/v1/accounts") return Response.json({ accounts: [{ _id: "b".repeat(24), platform: "instagram", profileId: "c".repeat(24) }] });
    if (path === "/v1/comment-automations" && method === "GET") return Response.json({ automations: [AUTO] });
    if (/^\/v1\/comment-automations\/\w+$/.test(path) && method === "PATCH") return Response.json({ automation: { ...AUTO, ...body } });
    if (/^\/v1\/comment-automations\/\w+\/logs$/.test(path)) return Response.json({ logs: [] });
  }
  throw new Error("unexpected fetch " + method + " " + url);
};

const assert = (c, m) => { if (!c) { console.error("FAIL", m); process.exit(1); } console.log("ok", m); };
const { loadConfig, saveConfig, storageState } = await import("../lib/config.js");
const { logEvent, readEvents } = await import("../lib/events.js");

let cfg = await loadConfig({ fresh: true });
assert(cfg.posts["777"]?.link === "https://seven.com" && cfg.posts["777"].gate === true && cfg.settings.linkDm.startsWith("اللينك أهو 👇"),
  "first load with an empty table: settings rebuilt (here from Zernio) …");
assert(DB.app_config.length === 1 && DB.app_config[0].data.posts["777"], "… and stored in Supabase");
assert(storageState.source.startsWith("db"), "source is the database");

const before = calls.length;
await loadConfig({ fresh: true });
assert(calls.slice(before).every((c) => c.startsWith("GET /rest/v1/app_config")), "later loads read the one row (no Zernio rebuild)");

cfg.settings.notFollowing = "تابع الأول 🙏";
await saveConfig(cfg);
assert(DB.app_config[0].data.settings.notFollowing === "تابع الأول 🙏" && (await loadConfig({ fresh: true })).settings.notFollowing === "تابع الأول 🙏", "saving writes the row, loading reads it back");

await logEvent("first", "777", "U1"); await logEvent("gate", "777", "U1"); await logEvent("link", "777", "U1"); await logEvent("click", "777", "k:" + "a".repeat(12));
const ev = await readEvents(2);
assert(ev.length === 4 && ev[0].type === "first" && ev.at(-1).user === "a".repeat(12) && ev[0].media === "777", "events go to Supabase and come back for the stats");

const admin = await import("../api/admin.js");
const st = await (await admin.GET(new Request("https://x/api/admin?action=stats&days=7", { headers: { "x-admin-key": "abc" } }))).json();
assert(st.totals.converted === 1 && st.totals.clicks >= 1 && st.totals.followRate === 100, "stats use the Supabase events (follow rate, clicks)");

DB.app_config = []; process.env.SUPABASE_SECRET_KEY = "wrong";
const kept = await loadConfig({ fresh: true });
assert(kept.posts["777"] && /Supabase 401/.test(storageState.error), "if Supabase fails, the last good settings are kept and the error is reported");
console.log("all good");
