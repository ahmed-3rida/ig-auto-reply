// «Answer what was missed» for the admin panel.
//  - comments(): the comments on one video that never got an answer (no reply from the account under them,
//    and no DM sent for them by Zernio), answered the same way a live comment is.
//  - dms(): conversations whose last message is someone sending a video's trigger word (on videos with
//    «الكلمة في الخاص» on) that nobody answered, inside Instagram's 24-hour reply window.
// Both work in small batches (Vercel time limit) and say how many are left, so the panel calls them again.
import { postComments, automationLogs, isFollower, conversations, conversationMessages, account } from "./zernio.js";
import { commentMatches } from "./sync.js";
import { answerComment, answerInDm } from "./respond.js";
import { defer, isBillingBlock } from "./quota.js";
import { findDmVideo } from "../api/zernio-webhook.js";
import { autoKeywords } from "./autokw.js";

const PRIVATE_REPLY_DAYS = 7;   // Instagram: a comment can get a private reply up to 7 days after it was written
const DM_WINDOW_H = 24;         // Instagram: a DM can be answered up to 24 hours after the person's last message

const repliedByUs = (c, ownIds) => (c.replies ?? []).some((r) => r.from?.isOwner || ownIds.has(String(r.from?.id)));

// Which of these comments did Zernio already answer (sent / gated)?
async function zernioAnswered(automationId) {
  if (!automationId) return new Set();
  try {
    const logs = await automationLogs(automationId, 100);
    return new Set(logs.filter((l) => ["sent", "gated"].includes(l.status)).map((l) => l.commentId));
  } catch { return new Set(); }
}

export async function comments({ id, cfg, base, max = 15, deadline = Date.now() + 40_000, now = Date.now() }) {
  const entry = cfg.posts[id];
  const out = { answered: 0, links: 0, firsts: 0, notFollowers: 0, alreadyDone: 0, tooOld: 0, noKeyword: 0, failed: 0, remaining: 0, errors: [] };
  if (!entry?.enabled) return { ...out, error: "الفيديو مش متفعّل" };
  const { accountId } = await account();
  const ownIds = new Set([accountId]);
  const done = await zernioAnswered(entry.automationId);

  // every top-level comment of the post
  const all = [];
  let cursor = null;
  do {
    const page = await postComments(id, cursor);
    all.push(...page.comments);
    cursor = page.cursor;
  } while (cursor && all.length < 1000);

  const todo = [];
  for (const c of all) {
    if (c.from?.isOwner) continue;
    if (repliedByUs(c, ownIds) || done.has(c.id)) { out.alreadyDone++; continue; }
    if (now - Date.parse(c.createdTime) > PRIVATE_REPLY_DAYS * 864e5) { out.tooOld++; continue; }
    if (!commentMatches(entry, c.message)) { out.noKeyword++; continue; }
    todo.push(c);
  }
  const asComment = (c) => ({ id: c.id, postId: id, authorId: c.from?.id, text: c.message, at: c.createdTime });
  for (const [i, c] of todo.entries()) {
    if (out.answered + out.failed >= max || Date.now() > deadline) break;
    try {
      const follows = entry.gate === false ? true : await isFollower(c.from?.id).catch(() => null);
      const kind = await answerComment({ id, entry, cfg, comment: asComment(c), follows, base });
      out.answered++; kind === "link" ? out.links++ : kind === "not-follower" ? out.notFollowers++ : out.firsts++;
    } catch (e) {
      if (e.quotaFull) {
        // hourly cap reached: the rest wait in the queue and go out by themselves when there is room
        for (const rest of todo.slice(i)) await defer({ id, comment: asComment(rest) }).catch(() => {});
        out.queued = todo.length - i; out.quotaFull = true; out.billing = !!e.billing;
        break;
      }
      out.failed++;
      if (out.errors.length < 5) out.errors.push({ user: c.from?.username, error: String(e.message).slice(0, 160) });
    }
  }
  out.remaining = out.quotaFull ? 0 : Math.max(0, todo.length - out.answered - out.failed);
  return out;
}

export async function dms({ cfg, base, max = 15, deadline = Date.now() + 40_000, now = Date.now() }) {
  const out = { answered: 0, links: 0, gated: 0, checked: 0, noKeyword: 0, tooOld: 0, answeredBefore: 0, failed: 0, remaining: 0, errors: [] };
  const { accountId } = await account();
  const auto = await autoKeywords({ fresh: true }).catch(() => new Map());
  const candidates = [];
  let cursor = null, pages = 0;
  do {
    const page = await conversations(cursor);
    for (const conv of page.items) {
      const at = Date.parse(conv.updatedTime);
      if (now - at > DM_WINDOW_H * 3600e3) { cursor = null; break; } // newest first: the rest are older
      candidates.push(conv);
    }
    cursor = cursor !== null ? page.cursor : null;
    pages++;
  } while (cursor && pages < 3);

  const todo = [];
  for (const conv of candidates) {
    if (Date.now() > deadline - 8000) break;
    out.checked++;
    const msgs = await conversationMessages(conv.id, 10).catch(() => []);
    const last = msgs[0];
    if (!last || last.direction !== "incoming" || last.metadata?.postbackPayload) { out.answeredBefore++; continue; } // answered, or a tap
    if (now - Date.parse(last.createdAt) > DM_WINDOW_H * 3600e3) { out.tooOld++; continue; }
    const hit = findDmVideo(cfg, String(last.message ?? ""), auto);
    if (!hit) { out.noKeyword++; continue; }
    todo.push({ conv, last, hit });
  }
  for (const { conv, last, hit } of todo) {
    if (out.answered + out.failed >= max || Date.now() > deadline) break;
    try {
      const r = await answerInDm({ ...hit, cfg, conversationId: conv.id, user: last.senderId ?? conv.participantId, handle: conv.accountUsername, base, eventType: "dm" });
      out.answered++; r === "link" ? out.links++ : out.gated++;
    } catch (e) {
      if (isBillingBlock(e)) { out.billing = true; break; } // every other one would fail the same way
      out.failed++;
      if (out.errors.length < 5) out.errors.push({ user: conv.participantUsername, error: String(e.message).slice(0, 160) });
    }
  }
  out.remaining = out.quotaFull ? 0 : Math.max(0, todo.length - out.answered - out.failed);
  void accountId;
  return out;
}
