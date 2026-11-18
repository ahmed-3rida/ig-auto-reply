// Zernio webhook (event: comment.received) — the «فيديوهات جاية» rules.
//
// A scheduled video has no id until it is published, so the panel can't make its automation ahead of time.
// When the first comment arrives on a video the panel doesn't know, this reads its caption (Zernio sends it),
// and if a rule matches it: saves the video with the rule's settings, creates its Zernio automation, and answers
// that first comment itself (the automation only answers comments posted after it exists).
//
// It also answers the buttons of DMs sent by the old viaSocket flows (event: message.received): their payload is
// the link itself (v1) or "msg:<media_id>" (v2). Zernio doesn't know those buttons, so without this a tap gets
// no answer. A tap is checked for a follow (asked fresh from Instagram) and gets the link, or «follow first»
// with a button carrying the same payload so the next tap checks again.
//
// Setup: in Zernio add a webhook to https://<your-site>/api/zernio-webhook for `comment.received` and
// `message.received` with a secret, and put the same secret in Vercel as ZERNIO_WEBHOOK_SECRET.
import crypto from "node:crypto";
import { loadConfig, saveConfig, findRuleV2 } from "../lib/config.js";
import { hasZernio, privateReply, publicReply, sendMessage, isFollower } from "../lib/zernio.js";
import { resolve } from "./link-v2.js";
import { automationBody, createOrAdopt, dmFor } from "../lib/sync.js";

const env = (k, d = "") => process.env[k] ?? d;
const busy = new Set(); // posts being set up right now (per server instance)

export function validSignature(raw, sig) {
  const secret = env("ZERNIO_WEBHOOK_SECRET");
  if (!secret) return false;
  const want = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(want), b = Buffer.from(String(sig ?? "").toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const ok = (extra = {}) => Response.json({ ok: true, ...extra });

export async function POST(request) {
  const raw = await request.text();
  if (!validSignature(raw, request.headers.get("x-zernio-signature") ?? request.headers.get("x-late-signature"))) {
    return Response.json({ error: "bad signature" }, { status: 401 });
  }
  let ev;
  try { ev = JSON.parse(raw); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }
  if (ev.event === "message.received") return oldButton(ev);
  if (ev.event !== "comment.received" || ev.comment?.platform !== "instagram") return ok({ skipped: "event" });

  const c = ev.comment, id = String(c.platformPostId ?? ev.post?.platformPostId ?? "");
  if (!/^\d+$/.test(id) || c.author?.isOwnAccount || c.isReply) return ok({ skipped: "comment" });
  if (!hasZernio()) return ok({ skipped: "no-zernio" });

  const cfg = await loadConfig({ fresh: true });
  if (!cfg.enabled) return ok({ skipped: "off" });
  if (cfg.posts[id]) return ok({ skipped: "known" });         // the video's own automation handles it
  const rule = findRuleV2(ev.post?.content ?? "", cfg.rules);
  if (!rule) return ok({ skipped: "no-rule" });
  if (busy.has(id)) return ok({ skipped: "busy" });
  busy.add(id);

  try {
    const entry = {
      enabled: true, mode: rule.mode, link: rule.link, message: rule.message, button: rule.button,
      keywords: rule.keywords, matchMode: rule.matchMode, reply: rule.reply, gate: rule.gate,
      caption: String(ev.post?.content ?? "").slice(0, 120), permalink: ev.post?.permalink ?? "", via: "rule:" + rule.match,
    };
    const body = automationBody(id, entry, cfg.settings, { active: true });
    const auto = await createOrAdopt(id, body);
    cfg.posts[id] = { ...entry, automationId: auto._id ?? "", syncedHash: "" };
    await saveConfig(cfg);

    // Answer this first comment ourselves, if it is one the rule's trigger words accept.
    const words = (rule.keywords ?? "").split(/[,،\n]/).map((w) => w.trim().toLowerCase()).filter(Boolean);
    const text = String(c.text ?? "").toLowerCase();
    if (words.length && !words.some((w) => text.includes(w))) return ok({ created: auto._id, answered: false });

    const postId = c.postId || id;
    const follows = c.author?.instagramProfile?.isFollower === true;
    if (!entry.gate || follows) {
      const dm = dmFor(entry, cfg.settings);
      await privateReply(postId, c.id, dm.dmMessage, dm.buttons);
    } else {
      // Can't run Zernio's follow check on a comment made before the automation existed: ask them to follow
      // and comment again (the new comment goes through the automation and its follow check).
      await privateReply(postId, c.id, "اعمل فولو للحساب الأول، وبعدها اكتب كومنت تاني وهيوصلك اللينك 👇", [
        { type: "url", title: cfg.settings.profileButton, url: `https://www.instagram.com/${ev.account?.username ?? ""}/` },
      ]);
    }
    const pick = (s) => { const l = String(s ?? "").split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 6); return l[Math.floor(Math.random() * l.length)]; };
    const reply = pick(entry.reply) || pick(cfg.settings.reply);
    await publicReply(postId, c.id, reply).catch((e) => console.error("public reply failed", e.message));
    return ok({ created: auto._id, answered: true });
  } catch (e) {
    console.error("zernio-webhook", id, e.message);
    return Response.json({ error: e.message }, { status: 500 });
  } finally {
    busy.delete(id);
  }
}

// ---- buttons of the old viaSocket DMs ----
const taps = new Map(); // `${sender}|${payload}` -> time (per instance), so a double tap gets one answer
const TAP_LOCK_MS = 15_000;

export async function oldButton(ev) {
  const m = ev.message ?? {}, meta = ev.metadata ?? {};
  const payload = String(meta.postbackPayload ?? "").trim();
  if (m.platform !== "instagram" || m.direction !== "incoming" || !payload) return ok({ skipped: "not-a-button" });
  const isOld = /^https?:\/\/\S+$/i.test(payload) || /^msg:\d+$/.test(payload);
  if (!isOld) return ok({ skipped: "not-old-button" });        // Zernio's own buttons are Zernio's job
  if (meta.standby) return ok({ skipped: "standby" });          // another app owns the chat: we can't answer
  if (!hasZernio()) return ok({ skipped: "no-zernio" });

  const sender = String(m.sender?.id ?? ""), convId = ev.conversation?.id ?? m.conversationId;
  if (!sender || !convId) return ok({ skipped: "no-sender" });
  const key = sender + "|" + payload, now = Date.now();
  for (const [k, t] of taps) if (now - t > TAP_LOCK_MS) taps.delete(k);
  if (taps.has(key)) return ok({ skipped: "double-tap" });
  taps.set(key, now);

  const cfg = await loadConfig();
  if (!cfg.enabled) return ok({ skipped: "off" });
  // what this button stands for: a bare link, or a video's reply in the panel
  let entry;
  if (payload.startsWith("msg:")) {
    const r = await resolve(payload.slice(4));
    if (!r.found) return ok({ skipped: "video-off" });
    entry = { enabled: true, mode: r.mode, link: r.link, message: r.message, button: r.button, gate: cfg.posts[payload.slice(4)]?.gate !== false };
  } else {
    const post = Object.values(cfg.posts).find((p) => p.link === payload);
    if (post && !post.enabled) return ok({ skipped: "video-off" });
    entry = { enabled: true, mode: "link", link: payload, button: post?.button || "", gate: post ? post.gate !== false : true };
  }

  try {
    const follows = entry.gate ? await isFollower(sender) : true;
    if (follows) {
      const dm = dmFor(entry, cfg.settings);
      await sendMessage(convId, dm.dmMessage, dm.buttons);
      return ok({ answered: "link" });
    }
    const handle = ev.account?.username;
    await sendMessage(convId, follows === false ? cfg.settings.notFollowing : cfg.settings.gateMessage, [
      ...(handle ? [{ type: "url", title: cfg.settings.profileButton, url: `https://www.instagram.com/${handle}/` }] : []),
      { type: "postback", title: cfg.settings.gateButton, payload },
    ]);
    return ok({ answered: "follow-first" });
  } catch (e) {
    taps.delete(key);
    console.error("old button", e.message);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
