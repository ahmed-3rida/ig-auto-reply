// TikTok, through Zernio:
//  - post an Instagram video to TikTok (the original file Instagram serves, so no watermark);
//  - a public reply under every comment on that TikTok video («ابعتلي <الكلمة> في الخاص»);
//  - answer the video's word when it is sent in a TikTok DM, with the link as plain text.
// TikTok has no private reply to a comment and no DM buttons; a business can only reply to someone who
// wrote first, up to 10 messages within 48 hours.
import crypto from "node:crypto";
import { zernio, account, ZernioError } from "./zernio.js";
import { effective, normalize } from "./config.js";
import { textLines, randomLine, keywordList } from "./sync.js";

const env = (k, d = "") => process.env[k] ?? d;
export const TT_NAME = "tiktok:";

let tt = null;
// { accountId, profileId, username } of the connected TikTok account (TIKTOK_ACCOUNT_ID picks one of several).
export async function tiktokAccount() {
  if (tt) return tt;
  const d = await zernio("GET", "/v1/accounts?platform=tiktok&limit=50");
  const list = (d.accounts ?? d.data ?? []).filter((a) => (a.platform ?? "tiktok") === "tiktok");
  const want = env("TIKTOK_ACCOUNT_ID");
  const a = list.find((x) => (x._id ?? x.id) === want) ?? list[0];
  if (!a) throw new ZernioError("حساب تيك توك مش متربط بـ Zernio", 404);
  tt = { accountId: a._id ?? a.id, profileId: typeof a.profileId === "object" ? a.profileId?._id : a.profileId, username: a.username ?? "" };
  return tt;
}

// The Instagram video behind a media id: { url, type, caption, permalink } (url = the original mp4).
export async function igVideo(id) {
  const { accountId } = await account();
  const q = new URLSearchParams({ accountId, limit: "1", view: "full" });
  const p = (await zernio("GET", `/v1/inbox/comments/${encodeURIComponent(id)}?${q}`)).post ?? {};
  return { url: p.mediaUrl ?? "", type: p.mediaType ?? "", caption: p.text ?? "", permalink: p.permalink ?? "" };
}

// «اكتب IDM في الكومنت وهبعتلك اللينك» -> «ابعتلي IDM في الخاص وهيوصلك اللينك 📩» (the rest of the caption as is).
export function tiktokCaption(caption = "", word = "") {
  const re = /اكتب\s+[«"'“]?([^\s«»"'“”]{2,30})[»"'”]?\s+(?:في|ف)\s*(?:ال)?(?:كومنت|كومنتات|تعليق|تعليقات)[^\n]*/i;
  const m = String(caption).match(re);
  const w = word || (m ? m[1] : "");
  if (!w) return String(caption).slice(0, 2200);
  const line = `ابعتلي ${w} في الخاص وهيوصلك اللينك 📩`;
  return (m ? String(caption).replace(re, line) : `${caption}\n\n${line}`).slice(0, 2200);
}

// The word a video answers to on TikTok: its own trigger word, the word chosen when posting, or the caption's.
export const ttWord = (entry, auto = "") => keywordList(entry?.keywords)[0] || entry?.tiktok?.word || auto || "";

// Replies under TikTok comments: the settings' lines with {الكلمة} / {word} filled in.
export function ttReplies(settings, word) {
  const fill = (s) => s.replace(/\{(?:الكلمة|word)\}/g, word || "الكلمة");
  return textLines(settings.ttReply).map(fill).slice(0, 6);
}

const hash = (o) => crypto.createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 16);

function replyBody(id, entry, cfg) {
  const [commentReply, ...commentReplyVariations] = ttReplies(cfg.settings, entry.tiktok.word);
  return {
    name: TT_NAME + id, trigger: "comment", keywords: [], matchMode: "contains",
    commentReply, commentReplyVariations: commentReplyVariations.slice(0, 5),
    repeatPolicy: { mode: cfg.settings.repeat === "once" ? "once" : "every_comment" },
    isActive: !!(cfg.enabled && entry.enabled && cfg.settings.tiktok !== false),
  };
}

// Post an Instagram video to TikTok and set up the replies under its comments. Mutates cfg.posts[id].tiktok.
// The post is scheduled a minute ahead so Zernio uploads it in the background (a TikTok upload can take
// longer than a request may run); its status is read later with refreshTiktok().
export async function publishTiktok(cfg, id, { caption, word }) {
  const entry = cfg.posts[id];
  if (!entry) throw new ZernioError("الفيديو مش في اللوحة — شغّله واحفظ الأول", 400);
  if (entry.tiktok?.postId && entry.tiktok.status !== "failed") throw new ZernioError("الفيديو ده اتنشر على تيك توك قبل كده", 409);
  const video = await igVideo(id);
  if (!/^https?:\/\//.test(video.url) || (video.type && video.type !== "VIDEO")) throw new ZernioError("ده مش فيديو، أو إنستجرام مش مدّي ملف الفيديو", 400);
  const { accountId, profileId } = await tiktokAccount();
  const text = String(caption ?? "").trim().slice(0, 2200) || tiktokCaption(video.caption, word);
  const d = await zernio("POST", "/v1/posts", {
    content: text,
    mediaItems: [{ type: "video", url: video.url }],
    platforms: [{ platform: "tiktok", accountId }],
    scheduledFor: new Date(Date.now() + 60_000).toISOString(),
    timezone: "UTC",
    tiktokSettings: {
      privacy_level: "PUBLIC_TO_EVERYONE", allow_comment: true, allow_duet: true, allow_stitch: true,
      content_preview_confirmed: true, express_consent_given: true,
    },
  });
  const post = d.post ?? d;
  entry.tiktok = { postId: post._id ?? post.id ?? "", status: "scheduled", url: "", videoId: "", word: String(word ?? "").trim().slice(0, 40), automationId: "", replyHash: "", error: "", at: new Date().toISOString() };
  // replies under its comments; bound to the Zernio post, so they start once TikTok has the video
  try {
    const body = replyBody(id, entry, cfg);
    const a = (await zernio("POST", "/v1/comment-automations", { profileId: profileId || (await account()).profileId, accountId, postId: entry.tiktok.postId, ...body })).automation ?? {};
    entry.tiktok.automationId = a._id ?? a.id ?? "";
    entry.tiktok.replyHash = hash(body);
  } catch (e) {
    entry.tiktok.error = "الرد على الكومنتات: " + String(e.message).slice(0, 200);
  }
  return entry.tiktok;
}

// Read where a TikTok post is (scheduled / publishing / published / failed). Mutates and returns entry.tiktok.
export async function refreshTiktok(entry) {
  const t = entry?.tiktok;
  if (!t?.postId) return t ?? null;
  const d = await zernio("GET", `/v1/posts/${encodeURIComponent(t.postId)}`);
  const post = d.post ?? d;
  const pl = (post.platforms ?? []).find((p) => p.platform === "tiktok") ?? {};
  const status = pl.status ?? post.status ?? t.status;
  t.status = ["published", "failed", "scheduled", "publishing"].includes(status) ? status : String(status || t.status).slice(0, 20);
  t.url = pl.platformPostUrl ?? t.url ?? "";
  t.videoId = String(pl.platformPostId ?? t.videoId ?? "");
  const err = pl.errorMessage ?? pl.error?.message ?? (typeof pl.error === "string" ? pl.error : "");
  if (t.status === "failed") t.error = String(err || post.error || "تيك توك رفض الفيديو").slice(0, 300);
  else if (t.status === "published" && !/^الرد/.test(t.error)) t.error = "";
  return t;
}

// Keep the TikTok reply automations in step with the settings (texts, on/off). Called after a save.
export async function syncTiktok(cfg) {
  for (const [id, p] of Object.entries(cfg.posts)) {
    const t = p.tiktok;
    if (!t?.automationId) continue;
    const body = replyBody(id, p, cfg), want = hash(body);
    if (want === t.replyHash) continue;
    try { await zernio("PATCH", `/v1/comment-automations/${encodeURIComponent(t.automationId)}`, body); t.replyHash = want; if (/^الرد/.test(t.error)) t.error = ""; }
    catch (e) { t.error = "الرد على الكومنتات: " + String(e.message).slice(0, 200); }
  }
}

// The video a TikTok DM asks for: enabled, and one of its words is in the message (longest word wins).
export function findTiktokVideo(cfg, text, auto = new Map()) {
  let best = null;
  const t = normalize(text);
  const words = t.split(/[^\p{L}\p{N}_#@]+/u).filter(Boolean);
  for (const [id, p] of Object.entries(cfg.posts)) {
    if (!p.enabled || !effective(p)) continue;
    const list = [...keywordList(p.keywords), p.tiktok?.word, auto.get(id)].filter(Boolean).map((w) => normalize(w));
    const hit = list.find((w) => words.includes(w) || (w.includes(" ") && t.includes(w)));
    if (hit && (!best || hit.length > best.len)) best = { id, entry: p, len: hit.length };
  }
  return best && { id: best.id, entry: best.entry };
}

// What a TikTok DM gets: a «لينك» line and the link under it (no buttons on TikTok), or the video's message.
export function tiktokDmText(entry, settings) {
  const e = effective(entry);
  if (!e) return "";
  if (e.mode === "message") return e.message.slice(0, 6000);
  if (e.mode === "both") return `${e.message}\n\n${e.link}`.slice(0, 6000);
  return `${randomLine(settings.ttDm) || "اتفضل اللينك 👇"}\n${e.link}`;
}

export const sendTiktokMessage = (accountId, conversationId, message) =>
  zernio("POST", `/v1/inbox/conversations/${encodeURIComponent(conversationId)}/messages`, { accountId, message });

export const _resetTiktok = () => { tt = null; }; // tests
