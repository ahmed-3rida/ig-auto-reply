// Should we answer this button tap? Used by the viaSocket "Link Button v2" flow so a person who taps
// Link / Following several times gets ONE answer — no database, it looks at the latest messages in the chat.
//
//   GET /api/should-reply?user=<sender IGSID>&kind=link|ask   ->  { reply: true|false, reason }
//
// kind=link (they follow you, about to get the link):
//   no  -> we already sent them a link message (one without the word "follow") in the last 24h,
//          or we sent them anything in the last few seconds (rapid taps).
// kind=ask  (they don't follow yet, about to get "follow first"):
//   no  -> we sent them anything in the last 30s (rapid taps).
// Plus a short in-memory lock so taps that arrive at the same moment don't all pass.
// If Instagram can't be reached we answer yes, so nobody gets stuck without a reply.
const env = (k, d = "") => process.env[k] ?? d;
const GRAPH = () => `https://graph.instagram.com/${env("GRAPH_VERSION", "v24.0")}`;
const num = (k, d) => Number(env(k, "")) || d;

const LINK_WINDOW = () => num("LINK_REPEAT_WINDOW_SEC", 24 * 3600) * 1000; // one link per person per day
const BURST = () => num("BURST_SEC", 15) * 1000; // any reply this recent = a rapid repeat
const ASK_BURST = () => num("ASK_BURST_SEC", 30) * 1000;
const LOCK = () => num("LOCK_SEC", 20) * 1000;

const locks = new Map(); // `${user}|${kind}` -> timestamp (per server instance)

async function graph(path) {
  const res = await fetch(`${GRAPH()}${path}`, { headers: { Authorization: `Bearer ${env("IG_ACCESS_TOKEN")}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Graph ${res.status}`);
  return data;
}

// Latest messages of the conversation with this person, newest first: [{ created_time, from: { id }, message }]
export const lastShape = {}; // for debug: what Instagram returned (keys/counts only)

export async function recentMessages(user) {
  const fields = "messages.limit(10){created_time,from,message}";
  const list = await graph(`/me/conversations?platform=instagram&user_id=${user}&fields=${encodeURIComponent(fields)}`);
  const conv = list.data?.[0];
  lastShape.conversations = list.data?.length ?? null;
  lastShape.convKeys = conv ? Object.keys(conv) : [];
  if (!conv) return [];
  let msgs = conv.messages?.data;
  if (!msgs) {
    const one = await graph(`/${conv.id}?fields=${encodeURIComponent(fields)}`); // nested fields not expanded
    lastShape.fallbackKeys = Object.keys(one);
    msgs = one.messages?.data ?? [];
  }
  // Some API versions return only message ids: fetch the details of the newest few.
  if (msgs.length && !msgs[0].created_time) {
    lastShape.detailFetch = true;
    msgs = await Promise.all(msgs.slice(0, 6).map((m) => graph(`/${m.id}?fields=created_time,from,message`).catch(() => ({}))));
  }
  lastShape.firstMsgKeys = msgs[0] ? Object.keys(msgs[0]) : [];
  return msgs;
}

export function decide(kind, messages, user, now = Date.now()) {
  const ours = messages
    .filter((m) => m?.from?.id && String(m.from.id) !== String(user))
    .map((m) => ({ at: Date.parse(m.created_time), text: String(m.message ?? "") }))
    .filter((m) => Number.isFinite(m.at));
  const within = (ms) => ours.filter((m) => now - m.at < ms);

  if (kind === "link") {
    // a "follow first" message seconds ago is fine (they just followed and tapped Following)
    if (within(BURST()).some((m) => !/follow/i.test(m.text))) return { reply: false, reason: "replied-seconds-ago" };
    if (within(LINK_WINDOW()).some((m) => m.text && !/follow/i.test(m.text))) return { reply: false, reason: "link-already-sent" };
    return { reply: true, reason: "ok" };
  }
  if (within(ASK_BURST()).length) return { reply: false, reason: "asked-seconds-ago" };
  return { reply: true, reason: "ok" };
}

export async function GET(request) {
  const u = new URL(request.url);
  const user = u.searchParams.get("user") ?? "";
  const kind = u.searchParams.get("kind") === "ask" ? "ask" : "link";
  const headers = { "Cache-Control": "no-store" };
  if (!/^\d{5,25}$/.test(user)) return Response.json({ reply: false, reason: "bad-user" }, { status: 400, headers });

  const key = `${user}|${kind}`;
  const now = Date.now();
  for (const [k, t] of locks) if (now - t > LOCK()) locks.delete(k);
  if (locks.has(key)) return Response.json({ reply: false, reason: "same-moment" }, { headers });
  locks.set(key, now);

  try {
    const msgs = await recentMessages(user);
    const result = decide(kind, msgs, user, now);
    if (u.searchParams.get("debug") === "2") {
      // which way of finding the conversation works (booleans/counts only)
      const tries = {};
      const t = async (name, path, pick) => { try { tries[name] = pick(await graph(path)); } catch (e) { tries[name] = "ERR " + String(e.message).slice(0, 120); } };
      const me = await graph(`/me?fields=user_id,id`).catch(() => ({}));
      tries.meHasUserId = !!me.user_id; tries.meIdEqualsUserId = me.id === me.user_id;
      await t("byMeUserId", `/me/conversations?platform=instagram&user_id=${user}`, (d) => d.data?.length ?? 0);
      if (me.user_id) await t("byIgIdUserId", `/${me.user_id}/conversations?platform=instagram&user_id=${user}`, (d) => d.data?.length ?? 0);
      await t("scanParticipants", `/me/conversations?platform=instagram&fields=participants&limit=100`, (d) => ({
        total: d.data?.length ?? 0,
        found: (d.data ?? []).some((c) => (c.participants?.data ?? []).some((p) => String(p.id) === user)),
        sampleIdLength: d.data?.[0]?.participants?.data?.map((p) => String(p.id).length) ?? [],
      }));
      locks.delete(key);
      return Response.json({ tries }, { headers });
    }
    if (u.searchParams.get("debug") === "1") {
      // shape only, never message contents
      const ours = msgs.filter((m) => m?.from?.id && String(m.from.id) !== user);
      result.debug = { messages: msgs.length, ours: ours.length, oursWithText: ours.filter((m) => m.message).length,
        newestOursAgoSec: ours.length ? Math.round((now - Date.parse(ours[0].created_time)) / 1000) : null, shape: lastShape };
      locks.delete(key);
    }
    if (!result.reply) locks.delete(key); // only a passing tap holds the lock
    return Response.json(result, { headers });
  } catch (e) {
    console.error("should-reply: Instagram check failed", e?.message);
    const out = { reply: true, reason: "check-failed" };
    if (u.searchParams.get("debug") === "2") {
      // which way of finding the conversation works (booleans/counts only)
      const tries = {};
      const t = async (name, path, pick) => { try { tries[name] = pick(await graph(path)); } catch (e) { tries[name] = "ERR " + String(e.message).slice(0, 120); } };
      const me = await graph(`/me?fields=user_id,id`).catch(() => ({}));
      tries.meHasUserId = !!me.user_id; tries.meIdEqualsUserId = me.id === me.user_id;
      await t("byMeUserId", `/me/conversations?platform=instagram&user_id=${user}`, (d) => d.data?.length ?? 0);
      if (me.user_id) await t("byIgIdUserId", `/${me.user_id}/conversations?platform=instagram&user_id=${user}`, (d) => d.data?.length ?? 0);
      await t("scanParticipants", `/me/conversations?platform=instagram&fields=participants&limit=100`, (d) => ({
        total: d.data?.length ?? 0,
        found: (d.data ?? []).some((c) => (c.participants?.data ?? []).some((p) => String(p.id) === user)),
        sampleIdLength: d.data?.[0]?.participants?.data?.map((p) => String(p.id).length) ?? [],
      }));
      locks.delete(key);
      return Response.json({ tries }, { headers });
    }
    if (u.searchParams.get("debug") === "1") { out.error = String(e?.message).slice(0, 200); locks.delete(key); }
    return Response.json(out, { headers });
  }
}
