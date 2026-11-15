// Instagram comment auto-reply webhook (Vercel Function).
// When someone comments with a keyword, reply to the comment and send them a DM with the link.
import crypto from "node:crypto";
import rules from "../rules.js";

const env = (k, d = "") => process.env[k] ?? d;
const GRAPH = () => `https://graph.instagram.com/${env("GRAPH_VERSION", "v24.0")}`;

// Arabic-friendly normalization: drop diacritics/tatweel, unify alef/ya/ta-marbuta, lowercase.
export function normalize(s = "") {
  return s
    .toLowerCase()
    .replace(/[ً-ْـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .trim();
}

export function matchesKeyword(text, keywords = env("KEYWORDS", "تحميل")) {
  const t = normalize(text);
  return keywords
    .split(",")
    .map((k) => normalize(k))
    .filter(Boolean)
    .some((k) => t.includes(k));
}

// Rules from rules.js, plus the old KEYWORDS/DOWNLOAD_LINK env vars as a fallback rule.
export function allRules(list = rules) {
  const out = [...(Array.isArray(list) ? list : [])];
  if (env("KEYWORDS") && env("DOWNLOAD_LINK")) out.push({ keyword: env("KEYWORDS"), link: env("DOWNLOAD_LINK") });
  return out.filter((r) => r && r.keyword && r.link);
}

// Pick the rule for this comment: rules pinned to this post win, then the longest matching keyword.
export function findRule(text, mediaId, list = allRules()) {
  const t = normalize(text);
  let best = null, bestScore = -1;
  for (const r of list) {
    if (r.media && String(r.media) !== String(mediaId ?? "")) continue;
    for (const k of String(r.keyword).split(",").map(normalize).filter(Boolean)) {
      if (!t.includes(k)) continue;
      const score = (r.media ? 1000 : 0) + k.length;
      if (score > bestScore) { best = r; bestScore = score; }
    }
  }
  return best;
}

function validSignature(raw, header) {
  const secret = env("APP_SECRET");
  if (!secret) return true; // allow local testing without secret
  if (!header?.startsWith("sha256=")) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function callGraph(path, body) {
  const res = await fetch(`${GRAPH()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env("IG_ACCESS_TOKEN")}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) console.error("Graph error", path, res.status, JSON.stringify(data));
  return { ok: res.ok, data };
}

function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

export async function handleComment(value, ownerId) {
  const commentId = value?.id;
  const text = value?.text ?? "";
  const from = value?.from ?? {};
  if (!commentId) return "no-comment-id";
  if (from.id && (from.id === ownerId || from.id === env("IG_USER_ID"))) return "own-comment";
  if (from.username && from.username === env("IG_USERNAME")) return "own-comment";
  const rule = findRule(text, value?.media?.id);
  if (!rule) return "no-keyword";

  const vars = { username: from.username ?? "", link: rule.link };
  const replyText = fill(rule.reply || env("COMMENT_REPLY", "بعتلك الرابط في الخاص ❤️"), vars);
  const dmText = fill(rule.dm || env("DM_MESSAGE", "أهلاً {username} 👋\nده رابط تحميل الأداة: {link}"), vars);

  // Private reply (DM) tied to the comment, then a public reply on the comment.
  const dm = await callGraph(`/me/messages`, { recipient: { comment_id: commentId }, message: { text: dmText } });
  const reply = await callGraph(`/${commentId}/replies`, { message: replyText });
  return `dm:${dm.ok} reply:${reply.ok}`;
}

// Meta verification handshake.
export function GET(request) {
  const u = new URL(request.url);
  if (u.searchParams.get("hub.mode") === "subscribe" && u.searchParams.get("hub.verify_token") === env("VERIFY_TOKEN")) {
    return new Response(u.searchParams.get("hub.challenge") ?? "", { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

export async function POST(request) {
  const raw = await request.text();
  if (!validSignature(raw, request.headers.get("x-hub-signature-256"))) {
    return new Response("Bad signature", { status: 401 });
  }
  if (env("ENABLED", "true") !== "true") return new Response("disabled");

  let body;
  try { body = JSON.parse(raw); } catch { return new Response("Bad JSON", { status: 400 }); }

  const results = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "comments") continue;
      results.push(await handleComment(change.value, entry.id));
    }
  }
  console.log("processed", results);
  return new Response("EVENT_RECEIVED", { status: 200 });
}
