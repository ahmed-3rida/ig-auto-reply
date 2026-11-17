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
export async function recentMessages(user) {
  const fields = "messages.limit(10){created_time,from,message}";
  const list = await graph(`/me/conversations?platform=instagram&user_id=${user}&fields=${encodeURIComponent(fields)}`);
  const conv = list.data?.[0];
  if (!conv) return [];
  if (conv.messages?.data) return conv.messages.data;
  const one = await graph(`/${conv.id}?fields=${encodeURIComponent(fields)}`); // fallback if nested fields aren't expanded
  return one.messages?.data ?? [];
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
    const result = decide(kind, await recentMessages(user), user, now);
    if (!result.reply) locks.delete(key); // only a passing tap holds the lock
    return Response.json(result, { headers });
  } catch (e) {
    console.error("should-reply: Instagram check failed", e?.message);
    return Response.json({ reply: true, reason: "check-failed" }, { headers });
  }
}
