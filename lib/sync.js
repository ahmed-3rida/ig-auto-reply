// Turns the panel settings of each video into a Zernio comment automation and keeps the two in step.
import crypto from "node:crypto";
import { effective } from "./config.js";
import { createAutomation, updateAutomation, deleteAutomation, listAutomations, ZernioError } from "./zernio.js";

const lines = (s) => String(s ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
export const keywordList = (s) => String(s ?? "").split(/[,،\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 50);
export const NAME_PREFIX = "panel:";

// The DM a video sends: { dmMessage, buttons } — or null when the entry has nothing usable.
export function dmFor(entry, settings) {
  const e = effective(entry);
  if (!e) return null;
  if (e.mode === "message") return { dmMessage: e.message, buttons: [] };
  const button = { type: "url", title: (e.button || "Link").slice(0, 20), url: e.link };
  // Instagram caps a message with buttons at 640 characters
  const text = e.mode === "both" ? e.message.slice(0, 640) : settings.linkDm;
  return { dmMessage: text, buttons: [button] };
}

// What someone gets before the follow check (Zernio's follow gate). In the "link" style the first DM looks
// like the link message, with a button named like the video's link button; the real link only comes after
// the tap confirms the follow.
export function gateFor(entry, settings, dm) {
  if (settings.gateStyle === "follow") {
    return { message: settings.gateMessage, buttonLabel: settings.gateButton, profileButtonLabel: settings.profileButton, notFollowingMessage: settings.notFollowing };
  }
  return {
    // always the short link text, so a «message» video doesn't give its content away before the check
    message: settings.linkDm,
    buttonLabel: (dm.buttons[0]?.title || effective(entry).button || "Link").slice(0, 20),
    // no open-profile button on the first DM so it reads like the link; the not-following reply still has
    // the same button to try again
    notFollowingMessage: settings.notFollowing,
  };
}

// Full automation body for one video (same shape for create and update).
export function automationBody(id, entry, settings, { active }) {
  const dm = dmFor(entry, settings);
  if (!dm) return null;
  const replies = lines(entry.reply);
  // the video's own replies, or else the default ones (several lines = Zernio picks one at random per comment)
  const [commentReply, ...commentReplyVariations] = replies.length ? replies : lines(settings.reply);
  // "link" style with the follow check on: the first DM always looks like the link — the link text and a
  // button named like the link button — whatever Zernio knows about the person. The button is a postback
  // ("msg:<id>") answered by /api/zernio-webhook, which checks the follow live and sends the real link or
  // «follow first». Zernio's own gate would skip that first DM for people it already knows.
  const tapFirst = entry.gate && settings.gateStyle !== "follow";
  const first = tapFirst
    ? { dmMessage: settings.linkDm, buttons: [{ type: "postback", title: (dm.buttons[0]?.title || effective(entry).button || "Link").slice(0, 20), payload: `msg:${id}` }] }
    : dm;
  return {
    name: NAME_PREFIX + id,
    trigger: "comment",
    platformPostId: id,
    postTitle: String(entry.caption || "").slice(0, 100) || undefined,
    keywords: keywordList(entry.keywords),
    matchMode: entry.matchMode || "contains",
    dmMessage: first.dmMessage,
    buttons: first.buttons,
    commentReply,
    commentReplyVariations: commentReplyVariations.slice(0, 5),
    linkTracking: true,
    repeatPolicy: { mode: "once" },
    publicReplyPolicy: "after_dm",
    audience: entry.gate && !tapFirst
      ? { followerStatus: "follower", whenUnknown: "verify" }
      : { followerStatus: "any", whenUnknown: "send" },
    followGate: gateFor(entry, settings, dm),
    isActive: !!active,
  };
}

const hash = (o) => crypto.createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 32);

// Bring Zernio in line with cfg. Mutates cfg.posts[*].automationId / syncedHash / syncError.
// Only videos whose settings changed since the last sync are sent, so a save costs a few calls.
export async function syncAll(cfg, { force = false } = {}) {
  const report = { created: 0, updated: 0, paused: 0, failed: 0, errors: [] };
  for (const [id, p] of Object.entries(cfg.posts)) {
    const active = cfg.enabled && p.enabled;
    const body = automationBody(id, p, cfg.settings, { active });
    // nothing usable and never synced -> nothing to do on Zernio
    if (!body && !p.automationId) { p.syncedHash = ""; p.syncError = ""; continue; }
    const want = body ? hash(body) : "off";
    if (!force && want === p.syncedHash && p.automationId) continue;
    try {
      if (!body) {
        await updateAutomation(p.automationId, { isActive: false });
        report.paused++;
      } else if (p.automationId) {
        try {
          await updateAutomation(p.automationId, body);
        } catch (e) {
          if (!(e instanceof ZernioError) || e.status !== 404) throw e;
          p.automationId = (await createAutomation(body))._id ?? "";   // deleted on Zernio: make it again
        }
        body.isActive ? report.updated++ : report.paused++;
      } else {
        if (!active) { p.syncedHash = want; p.syncError = ""; continue; }  // off and never created: skip
        p.automationId = (await createOrAdopt(id, body))._id ?? "";
        report.created++;
      }
      p.syncedHash = want; p.syncError = "";
    } catch (e) {
      p.syncError = String(e.message).slice(0, 300); report.failed++;
      report.errors.push({ id, error: p.syncError });
    }
  }
  return report;
}

// Create, or if Zernio already has an automation on this post (409, or one made outside the panel), take it over.
export async function createOrAdopt(id, body) {
  try {
    return await createAutomation(body);
  } catch (e) {
    if (!(e instanceof ZernioError) || e.status !== 409) throw e;
    const existing = (await listAutomations()).find((a) => a.platformPostId === id);
    if (!existing) throw e;
    return { ...(await updateAutomation(existing._id ?? existing.id, body)), _id: existing._id ?? existing.id };
  }
}

// Zernio automations on a post the panel doesn't know yet (made in Zernio itself) -> panel entries,
// so they show up and can be edited. Returns how many were added.
export function adoptExternal(cfg, automations) {
  let added = 0;
  const known = new Set(Object.values(cfg.posts).map((p) => p.automationId).filter(Boolean));
  for (const a of automations) {
    const id = a.platformPostId, aid = a._id ?? a.id;
    if (!id || !/^\d+$/.test(id) || known.has(aid) || a.trigger !== "comment") continue;
    if (cfg.posts[id]?.automationId) continue;
    const url = (a.buttons ?? []).find((b) => b.type === "url");
    const gated = a.audience?.followerStatus === "follower";
    cfg.posts[id] = {
      ...(cfg.posts[id] ?? {}),
      enabled: !!a.isActive,
      mode: url ? (a.dmMessage && a.dmMessage !== cfg.settings.linkDm ? "both" : "link") : "message",
      link: url?.url ?? (a.dmMessage?.match(/^https?:\/\/\S+$/) ? a.dmMessage.trim() : ""),
      message: url ? a.dmMessage ?? "" : a.dmMessage ?? "",
      button: url?.title ?? "",
      keywords: (a.keywords ?? []).join(", "),
      matchMode: a.matchMode ?? "contains",
      reply: [a.commentReply, ...(a.commentReplyVariations ?? [])].filter(Boolean).join("\n"),
      gate: gated,
      caption: a.postTitle ?? cfg.posts[id]?.caption ?? "",
      automationId: aid,
      syncedHash: "",      // re-sent with the panel's shape on the next save
      via: "zernio",
    };
    // A DM that is only a link (as made by hand) reads better as reply type «لينك»
    if (!url && /^https?:\/\/\S+$/.test(String(a.dmMessage ?? "").trim())) Object.assign(cfg.posts[id], { mode: "link", message: "" });
    added++;
  }
  return added;
}

// Per-video numbers from Zernio for the panel: { [mediaId]: { triggered, dmsSent, linkClicks, ... } }
export function statsByPost(automations) {
  const out = {};
  for (const a of automations) if (a.platformPostId) out[a.platformPostId] = { ...(a.stats ?? {}), isActive: !!a.isActive, automationId: a._id ?? a.id };
  return out;
}
