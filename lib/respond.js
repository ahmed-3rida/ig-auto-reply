// One place that decides and sends what someone gets, used by the webhook (live comments, button taps,
// keywords in DMs) and by the admin «answer what was missed» buttons.
import crypto from "node:crypto";
import { effective, findRuleV2, loadConfig } from "./config.js";
import { privateReply, publicReply, sendMessage, isFollower } from "./zernio.js";
import { dmFor, tapFirstDm, usesTapFirst } from "./sync.js";
import { logEvent, userKey } from "./events.js";
import { getCaption } from "./links.js";
import { roomLeft, QuotaFull } from "./quota.js";

const env = (k, d = "") => process.env[k] ?? d;
const secret = () => env("ZERNIO_WEBHOOK_SECRET") || env("VERIFY_TOKEN") || "dev";
const sign = (s) => crypto.createHmac("sha256", secret()).update(s).digest("hex").slice(0, 16);

// Public base of this site, for tracked links (https://<site>). PUBLIC_URL wins over the request's host.
export const baseOf = (request) => env("PUBLIC_URL").replace(/\/$/, "") || (request ? new URL(request.url).origin : "");

// Link through /api/go so a click is counted; signed so it can't be used as an open redirect.
export function trackedUrl(base, media, user) {
  if (!base) return null;
  const u = userKey(user), sig = sign(`${media}|${u}`);
  return `${base}/api/go?m=${media}&u=${u}&s=${sig}`;
}
export const checkTracked = (media, u, s) => !!s && s === sign(`${media}|${u}`);

// The real DM for a video, its link button tracked when a base URL is known.
export function realDm(id, entry, settings, base, user) {
  const dm = dmFor(entry, settings);
  if (!dm) return null;
  if (dm.buttons[0]?.type === "url" && id !== "0") {   // "0" = a bare link not in the panel: send it as is
    const url = trackedUrl(base, id, user);
    if (url) dm.buttons = [{ ...dm.buttons[0], url }];
  }
  return dm;
}

// «Follow first» for someone who doesn't follow yet: open-profile button + a button that checks again.
export function followFirstDm(id, entry, settings, handle, known) {
  // the retry button is always «عملت فولو» (settings.gateButton), never the link's name
  const title = String(settings.gateButton || "عملت فولو ✅").slice(0, 20);
  return {
    dmMessage: known === false ? settings.notFollowing : settings.gateMessage,
    buttons: [
      ...(handle ? [{ type: "url", title: settings.profileButton, url: `https://www.instagram.com/${handle}/` }] : []),
      { type: "postback", title, payload: `msg:${id}` },
    ],
  };
}

const pick = (s) => { const l = String(s ?? "").split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 6); return l[Math.floor(Math.random() * l.length)]; };
export const publicText = (entry, settings) => pick(entry.reply) || pick(settings.reply);

// Answer one comment: private reply (first DM or the real link) + public reply.
// follows: true / false / null (unknown). Returns "link" | "first".
export async function answerComment({ id, entry, cfg, comment, follows, base }) {
  const postId = comment.postId || id;
  const direct = !entry.gate || follows === true;
  const dm = direct ? realDm(id, entry, cfg.settings, base, comment.authorId) : (usesTapFirst(entry, cfg.settings) ? tapFirstDm(id, entry, cfg.settings) : followFirstDm(id, entry, cfg.settings, "", follows));
  // hourly cap (lib/quota.js): the caller queues the comment instead
  if (await roomLeft() <= 0) throw new QuotaFull();
  await privateReply(postId, comment.id, dm.dmMessage, dm.buttons);
  await logEvent("pr", id, comment.authorId);
  await logEvent(direct ? "link" : "first", id, comment.authorId);
  const reply = publicText(entry, cfg.settings);
  if (reply) await publicReply(postId, comment.id, reply).catch((e) => console.error("public reply failed", e.message));
  return direct ? "link" : "first";
}

// What a "msg:<id>" button (or an old viaSocket link button) stands for: { id, entry } or null.
export async function entryForPayload(cfg, payload) {
  const m = payload.match(/^msg:(\d+)$/);
  if (m) {
    const id = m[1];
    if (cfg.posts[id]) return effective(cfg.posts[id]) ? { id, entry: cfg.posts[id] } : null;
    const rule = findRuleV2(await getCaption(id), cfg.rules);
    return rule ? { id, entry: rule } : null;
  }
  if (/^https?:\/\/\S+$/i.test(payload)) {
    const hit = Object.entries(cfg.posts).find(([, p]) => p.link === payload);
    if (hit && !hit[1].enabled) return null;
    return { id: hit?.[0] ?? "0", entry: hit?.[1] ?? { enabled: true, mode: "link", link: payload, gate: true } };
  }
  return null;
}

// Answer in a DM thread (a button tap, or a keyword sent as a message). Checks the follow live.
export async function answerInDm({ id, entry, cfg, conversationId, user, handle, base, eventType = "link" }) {
  const follows = entry.gate === false ? true : await isFollower(user);
  if (follows) {
    const dm = realDm(id, entry, cfg.settings, base, user);
    await sendMessage(conversationId, dm.dmMessage, dm.buttons);
    await logEvent(eventType, id, user);
    return "link";
  }
  const dm = followFirstDm(id, entry, cfg.settings, handle, follows);
  await sendMessage(conversationId, dm.dmMessage, dm.buttons);
  await logEvent("gate", id, user);
  return "follow-first";
}

export { loadConfig };
