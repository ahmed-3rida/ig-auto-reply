// Zernio webhook. Setup: in Zernio add a webhook to https://<your-site>/api/zernio-webhook for
// `comment.received` and `message.received`, with a secret; put the same secret in Vercel as ZERNIO_WEBHOOK_SECRET.
//
// comment.received
//  - a video in the panel, "link" style: Zernio answers people it knows follow; this answers everyone else
//    with the first DM (a button that checks the follow), once Zernio's own verdict on the comment is known.
//  - a video not in the panel whose caption matches a «فيديوهات جاية» rule: the video is added, its
//    automation created, and this first comment answered here.
// message.received
//  - a tap on a "msg:<id>" button (or an old viaSocket link button): checks the follow live and sends the real
//    link, or «follow first» with a button to try again.
//  - a plain message containing a video's trigger word, on a video with «الكلمة في الخاص» on: same answer.
import crypto from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { loadConfig, saveConfig, findRuleV2 } from "../lib/config.js";
import { hasZernio, automationLogs } from "../lib/zernio.js";
import { automationBody, createOrAdopt, usesTapFirst, commentMatches } from "../lib/sync.js";
import { answerComment, answerInDm, entryForPayload, baseOf } from "../lib/respond.js";
import { autoKeywords } from "../lib/autokw.js";
import { findTiktokVideo, tiktokDmText, sendTiktokMessage } from "../lib/tiktok.js";
import { logEvent } from "../lib/events.js";

export const maxDuration = 60; // room to wait out Zernio's rate limit after answering the webhook

const env = (k, d = "") => process.env[k] ?? d;
const busy = new Set(); // posts being set up right now (per server instance)
const ok = (extra = {}) => Response.json({ ok: true, ...extra });

export function validSignature(raw, sig) {
  const secret = env("ZERNIO_WEBHOOK_SECRET");
  if (!secret) return false;
  const want = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(want), b = Buffer.from(String(sig ?? "").toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(request) {
  const raw = await request.text();
  if (!validSignature(raw, request.headers.get("x-zernio-signature") ?? request.headers.get("x-late-signature"))) {
    return Response.json({ error: "bad signature" }, { status: 401 });
  }
  let ev;
  try { ev = JSON.parse(raw); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }
  const base = baseOf(request);
  const work = (async () => {
    try {
      if (ev.event === "message.received") return await onMessage(ev, base);
      if (ev.event === "comment.received") return await onComment(ev, base);
      return ok({ skipped: "event" });
    } catch (e) {
      console.error("zernio-webhook", e.message);
      return Response.json({ error: e.message }, { status: 500 });
    }
  })();
  // Zernio gives a webhook only a few seconds. Quick answers (skips, standby…) are returned as they are; anything
  // slower (waiting for Zernio's verdict, sending the DM) carries on after we've answered 200, so Zernio doesn't
  // time out and send the same event again.
  const late = Symbol("late");
  const first = await Promise.race([work, new Promise((r) => setTimeout(() => r(late), timing.answerWithinMs))]);
  if (first !== late) return first;
  waitUntil(work);
  return ok({ queued: true });
}

// ---------------------------------------------------------------- comments
async function onComment(ev, base) {
  const c = ev.comment;
  if (c?.platform !== "instagram") return ok({ skipped: "event" });
  const id = String(c.platformPostId ?? ev.post?.platformPostId ?? "");
  if (!/^\d+$/.test(id) || c.author?.isOwnAccount || c.isReply) return ok({ skipped: "comment" });
  if (!hasZernio()) return ok({ skipped: "no-zernio" });
  const cfg = await loadConfig(); // cached for a minute: every Blob read counts against Vercel's free quota
  if (!cfg.enabled) return ok({ skipped: "off" });
  return cfg.posts[id] ? firstDm(ev, cfg, id, base) : fromRule(ev, cfg, id, base);
}

const answered = new Map(); // `${author}|${post}` -> time (per instance), for the «first comment only» setting
const REPEAT_MS = 24 * 3600 * 1000;
const commentOf = (c, id) => ({ id: c.id, postId: c.postId || id, authorId: c.author?.id, text: c.text });

export async function firstDm(ev, cfg, id, base) {
  const c = ev.comment, entry = cfg.posts[id];
  if (!entry.enabled || !usesTapFirst(entry, cfg.settings)) return ok({ skipped: "known" });
  if (!commentMatches(entry, c.text)) return ok({ skipped: "no-keyword" });
  // Zernio decides first (its own follow lookup, which can differ from the one in this webhook).
  const verdict = await zernioVerdict(entry.automationId, c.id);
  if (verdict === "sent") return ok({ skipped: "zernio-sent" });
  if (verdict === "repeat") return ok({ skipped: "zernio-repeat" });
  const key = `${c.author?.id}|${id}`, now = Date.now();
  const repeatMs = cfg.settings.repeat === "once" ? REPEAT_MS : 0;
  if (now - (answered.get(key) ?? 0) < repeatMs) return ok({ skipped: "already-answered" });
  answered.set(key, now);
  try {
    await answerComment({ id, entry, cfg, comment: commentOf(c, id), follows: null, base });
  } catch (e) {
    if (e.status === 429) throw e;   // still rate limited after waiting: an error, not a refusal (see the status page)
    return ok({ skipped: "private-reply-refused", error: e.message });
  }
  return ok({ answered: "tap-first" });
}

async function fromRule(ev, cfg, id, base) {
  const c = ev.comment;
  const rule = findRuleV2(ev.post?.content ?? "", cfg.rules);
  if (!rule) return ok({ skipped: "no-rule" });
  if (busy.has(id)) return ok({ skipped: "busy" });
  busy.add(id);
  try {
    const entry = {
      enabled: true, mode: rule.mode, link: rule.link, message: rule.message, button: rule.button,
      keywords: rule.keywords, matchMode: rule.matchMode, reply: rule.reply, gate: rule.gate, dmKeywords: rule.dmKeywords,
      caption: String(ev.post?.content ?? "").slice(0, 120), permalink: ev.post?.permalink ?? "", via: "rule:" + rule.match,
    };
    const auto = await createOrAdopt(id, automationBody(id, entry, cfg.settings, { active: true }));
    cfg.posts[id] = { ...entry, automationId: auto._id ?? "", syncedHash: "" };
    await saveConfig(cfg);
    if (!commentMatches(entry, c.text)) return ok({ created: auto._id, answered: false });
    const follows = c.author?.instagramProfile?.isFollower ?? null;
    await answerComment({ id, entry, cfg, comment: commentOf(c, id), follows, base });
    return ok({ created: auto._id, answered: true });
  } finally {
    busy.delete(id);
  }
}

// tries × waitMs: how long to wait for Zernio's verdict (runs after the webhook has answered, see POST)
export const timing = { tries: 5, waitMs: 1500, answerWithinMs: 2500 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "sent" | "repeat" | "blocked" | "none" — what the video's Zernio automation did with this comment.
export async function zernioVerdict(automationId, commentId) {
  if (!automationId) return "none";
  // Zernio takes a moment to log a comment: wait first instead of asking right away
  await sleep(timing.waitMs);
  for (let i = 0; i < timing.tries; i++) {
    let log;
    try { log = (await automationLogs(automationId, 20)).find((l) => l.commentId === commentId); } catch { return "none"; }
    if (log) {
      if (["sent", "gated"].includes(log.status)) return "sent";
      if (/already sent/i.test(log.error ?? "")) return "repeat";
      if (log.status === "pending" || log.status === "queued") { await sleep(timing.waitMs); continue; }
      return "blocked";
    }
    if (i < timing.tries - 1) await sleep(timing.waitMs);
  }
  return "none";
}

// ---------------------------------------------------------------- DMs
const taps = new Map(); // tap/keyword key -> time (per instance), so a double tap gets one answer
const TAP_LOCK_MS = 4_000; // only true double taps; «عملت فولو» right after «follow first» must go through

const lock = (key) => {
  const now = Date.now();
  for (const [k, t] of taps) if (now - t > TAP_LOCK_MS) taps.delete(k);
  if (taps.has(key)) return false;
  taps.set(key, now);
  return true;
};

async function onMessage(ev, base) {
  const m = ev.message ?? {}, meta = ev.metadata ?? {};
  if (m.platform === "tiktok") return tiktokMessage(ev);
  if (m.platform !== "instagram" || m.direction !== "incoming") return ok({ skipped: "not-a-button" });
  const payload = String(meta.postbackPayload ?? "").trim();
  if (payload) return oldButton(ev, base);
  return dmKeyword(ev, base);
}

// A tap on a "msg:<id>" button or an old viaSocket link button.
export async function oldButton(ev, base = "") {
  const m = ev.message ?? {}, meta = ev.metadata ?? {};
  const payload = String(meta.postbackPayload ?? "").trim();
  if (m.platform !== "instagram" || m.direction !== "incoming" || !payload) return ok({ skipped: "not-a-button" });
  if (!/^https?:\/\/\S+$/i.test(payload) && !/^msg:\d+$/.test(payload)) return ok({ skipped: "not-old-button" }); // Zernio's own buttons
  if (meta.standby) return ok({ skipped: "standby" });          // another app owns the chat: we can't answer
  if (!hasZernio()) return ok({ skipped: "no-zernio" });
  const sender = String(m.sender?.id ?? ""), conversationId = ev.conversation?.id ?? m.conversationId;
  if (!sender || !conversationId) return ok({ skipped: "no-sender" });
  if (!lock([sender, payload, meta.postbackTitle ?? ""].join("|"))) return ok({ skipped: "double-tap" });

  const cfg = await loadConfig();
  if (!cfg.enabled) return ok({ skipped: "off" });
  const hit = await entryForPayload(cfg, payload);
  if (!hit) return ok({ skipped: "video-off" });
  try {
    const answered = await answerInDm({ ...hit, cfg, conversationId, user: sender, handle: ev.account?.username, base });
    return ok({ answered });
  } catch (e) {
    taps.delete([sender, payload, meta.postbackTitle ?? ""].join("|"));
    throw e;
  }
}

// A plain message with a video's trigger word, on a video that has «الكلمة في الخاص» on.
export async function dmKeyword(ev, base = "") {
  const m = ev.message ?? {}, meta = ev.metadata ?? {};
  const text = String(m.text ?? "").trim();
  if (!text) return ok({ skipped: "no-text" });
  if (!hasZernio()) return ok({ skipped: "no-zernio" });
  const cfg = await loadConfig();
  if (!cfg.enabled) return ok({ skipped: "off" });
  const hit = findDmVideo(cfg, text, await autoKeywords().catch(() => new Map()));
  if (!hit) return ok({ skipped: "no-keyword" });
  if (meta.standby) return ok({ skipped: "standby" });
  const sender = String(m.sender?.id ?? ""), conversationId = ev.conversation?.id ?? m.conversationId;
  if (!sender || !conversationId) return ok({ skipped: "no-sender" });
  if (!lock(`${sender}|kw|${hit.id}`)) return ok({ skipped: "double-tap" });
  const answered = await answerInDm({ ...hit, cfg, conversationId, user: sender, handle: ev.account?.username, base, eventType: "dm" });
  return ok({ answered, video: hit.id });
}

// The video a DM's text asks for: enabled, «الكلمة في الخاص» on, has trigger words and one of them matches.
// The longest matching word wins (so "IDM" beats "I").
// The video a DM's text asks for. A video counts when it is on and «الكلمة في الخاص» is on for it (or for all
// videos in the settings). Its words are its trigger words, or else the word its caption asks for
// («اكتب IDM في الكومنت»), matched as a whole word. The longest matching word wins.
export function findDmVideo(cfg, text, auto = new Map()) {
  let best = null;
  for (const [id, p] of Object.entries(cfg.posts)) {
    if (!p.enabled || !(p.dmKeywords || cfg.settings.dmAll !== false)) continue;
    const own = String(p.keywords ?? "").trim();
    const words = own || auto.get(id) || "";
    if (!words) continue;
    const probe = own ? p : { keywords: words, matchMode: "word" };
    if (!commentMatches(probe, text)) continue;
    const len = Math.max(...words.split(/[,،\n]/).map((w) => w.trim().length));
    if (!best || len > best.len) best = { id, entry: p, len };
  }
  return best && { id: best.id, entry: best.entry };
}

// A TikTok DM with a video's word: the link as plain text (TikTok has no DM buttons and no follow check).
export async function tiktokMessage(ev) {
  const m = ev.message ?? {};
  if (m.direction !== "incoming") return ok({ skipped: "outgoing" });
  const text = String(m.text ?? "").trim();
  if (!text) return ok({ skipped: "no-text" });
  if (!hasZernio()) return ok({ skipped: "no-zernio" });
  const cfg = await loadConfig();
  if (!cfg.enabled || cfg.settings.tiktok === false) return ok({ skipped: "off" });
  const hit = findTiktokVideo(cfg, text, await autoKeywords().catch(() => new Map()));
  if (!hit) return ok({ skipped: "no-keyword" });
  const sender = String(m.sender?.id ?? ""), conversationId = ev.conversation?.id ?? m.conversationId;
  const accountId = ev.account?.id ?? ev.account?.accountId ?? m.accountId;
  if (!sender || !conversationId || !accountId) return ok({ skipped: "no-sender" });
  if (!lock(`tt|${sender}|${hit.id}`)) return ok({ skipped: "double-tap" });
  const message = tiktokDmText(hit.entry, cfg.settings);
  if (!message) return ok({ skipped: "video-off" });
  try { await sendTiktokMessage(accountId, conversationId, message); }
  catch (e) {
    // TikTok refuses business DMs for this account (no Advanced Access / outside the 48h window): a retry
    // won't change that, so answer 200 and say why instead of making Zernio send the event again
    if (e.status >= 400 && e.status < 500) return ok({ skipped: "tiktok-refused", video: hit.id, error: String(e.message).slice(0, 200) });
    throw e;
  }
  await logEvent("dm", hit.id, "tt:" + sender);
  return ok({ answered: "tiktok", video: hit.id });
}
