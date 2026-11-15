// Instagram auto-reply webhook (Vercel Function) — same logic as the old viaSocket flows:
//
// 1) Comment on an enabled post  -> public reply (random) + private reply with a "Link" postback button
//                                    whose payload is that post's link.
// 2) They tap "Link" (postback)    -> if they follow you: ❤️ react + message with a URL button to the link.
//                                    if not: "follow first" message + a "Following" button to try again.
import crypto from "node:crypto";
import { loadConfig } from "../lib/config.js";

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

export function matchesKeyword(text, keywords) {
  const list = String(keywords ?? "").split(",").map(normalize).filter(Boolean);
  if (!list.length) return true; // no keyword = every comment
  const t = normalize(text);
  return list.some((k) => t.includes(k));
}

export const pick = (list, fallback = "") => (Array.isArray(list) && list.length ? list[Math.floor(Math.random() * list.length)] : fallback);
const fill = (template, vars) => String(template ?? "").replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
const isLink = (s) => /^https?:\/\/\S+$/i.test(String(s ?? "").trim());

function validSignature(raw, header) {
  const secret = env("APP_SECRET");
  if (!secret) return true; // allow local testing without secret
  if (!header?.startsWith("sha256=")) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function graph(method, path, body) {
  const res = await fetch(`${GRAPH()}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env("IG_ACCESS_TOKEN")}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) console.error("Graph error", method, path, res.status, JSON.stringify(data));
  return { ok: res.ok, data };
}

const buttonTemplate = (text, buttons) => ({
  attachment: { type: "template", payload: { template_type: "button", text: String(text).slice(0, 640), buttons } },
});

// ---------- 1) comments ----------
export async function handleComment(value, ownerId, cfg) {
  const commentId = value?.id;
  const text = value?.text ?? "";
  const from = value?.from ?? {};
  const mediaId = value?.media?.id;
  if (!commentId) return "no-comment-id";
  if (from.id && (from.id === ownerId || from.id === env("IG_USER_ID"))) return "own-comment";
  if (from.username && from.username === env("IG_USERNAME")) return "own-comment";
  if (!cfg.enabled) return "disabled";

  const post = cfg.posts?.[mediaId];
  if (!post || !post.enabled || !isLink(post.link)) return "post-not-configured";
  if (!matchesKeyword(text, post.keyword)) return "no-keyword";

  const vars = { username: from.username ?? "", link: post.link };
  const replyText = fill(post.reply || pick(cfg.commentReplies), vars);
  const dmText = fill(post.dm || pick(cfg.dmMessages, "Tap LINK 👇"), vars);

  // Public reply first, then the private reply with the "Link" postback button (payload = the link).
  const reply = replyText ? await graph("POST", `/${commentId}/replies`, { message: replyText }) : { ok: true };
  const dm = await graph("POST", `/me/messages`, {
    recipient: { comment_id: commentId },
    message: buttonTemplate(dmText, [{ type: "postback", title: cfg.linkButtonTitle || "Link", payload: post.link }]),
  });
  return `reply:${reply.ok} dm:${dm.ok}`;
}

// ---------- 2) button taps (postbacks) ----------
export async function userFollows(igsid) {
  const r = await graph("GET", `/${igsid}?fields=is_user_follow_business`);
  if (!r.ok) return null; // unknown
  return r.data?.is_user_follow_business === true;
}

export async function handlePostback(event, ownerId, cfg) {
  const senderId = event?.sender?.id;
  const payload = String(event?.postback?.payload ?? "").trim();
  if (!senderId || senderId === ownerId) return "own";
  if (!isLink(payload)) return "not-ours"; // only our Link/Following buttons carry a URL
  if (!cfg.enabled) return "disabled";

  let follows = true;
  if (cfg.followGate) {
    const f = await userFollows(senderId);
    follows = f !== false; // if Instagram can't tell us, don't block the user
  }

  if (follows) {
    const mid = event.postback?.mid;
    if (cfg.reactOnLink && mid) {
      await graph("POST", `/me/messages`, { recipient: { id: senderId }, sender_action: "react", payload: { message_id: mid, reaction: "love" } });
    }
    const r = await graph("POST", `/me/messages`, {
      recipient: { id: senderId },
      message: buttonTemplate(pick(cfg.followerReplies, "👇"), [{ type: "web_url", title: cfg.urlButtonTitle || "Open", url: payload }]),
    });
    return `link-sent:${r.ok}`;
  }

  const r = await graph("POST", `/me/messages`, {
    recipient: { id: senderId },
    message: buttonTemplate(pick(cfg.nonFollowerMessages, "Follow first 🙏"), [
      { type: "postback", title: cfg.followingButtonTitle || "Following", payload },
    ]),
  });
  return `ask-follow:${r.ok}`;
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

  const cfg = await loadConfig();
  const results = [];
  for (const entry of body.entry ?? []) {
    const ownerId = entry.id;
    for (const change of entry.changes ?? []) {
      if (change.field === "comments") results.push(await handleComment(change.value, ownerId, cfg));
    }
    for (const ev of entry.messaging ?? []) {
      if (ev.postback && !ev.message?.is_echo) results.push(await handlePostback(ev, ownerId, cfg));
    }
  }
  console.log("processed", results);
  return new Response("EVENT_RECEIVED", { status: 200 });
}
