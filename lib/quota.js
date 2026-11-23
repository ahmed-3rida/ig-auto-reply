// Hourly cap on private replies to comments. Instagram restricts an account that sends too many automated DMs
// in an hour (after a reconnect the panel once sent 605 in one hour and private replies got blocked), so above
// the cap a comment waits in Supabase (pending_replies) and goes out later, oldest first, when there is room.
// Env: PRIVATE_REPLIES_PER_HOUR (default 150).
import { hasDb, countRows, enqueuePending, takePending } from "./db.js";

export const quota = { perHour: () => Math.max(1, Number(process.env.PRIVATE_REPLIES_PER_HOUR) || 150) };

export class QuotaFull extends Error {
  constructor() { super("وصلنا للحد في الساعة"); this.quotaFull = true; }
}

// Private replies sent in the last hour (counted from the event log, shared by every server).
export async function usedLastHour() {
  if (!hasDb()) return 0;
  return countRows("events", `type=eq.pr&at=gte.${encodeURIComponent(new Date(Date.now() - 3600e3).toISOString())}`);
}

// How many more private replies may go out right now. Without Supabase there's no shared count: no cap.
export async function roomLeft() {
  if (!hasDb()) return Infinity;
  try { return Math.max(0, quota.perHour() - await usedLastHour()); }
  catch (e) { console.error("quota", e.message); return Infinity; } // a counting error must not stop the replies
}

export const pendingCount = async () => (hasDb() ? countRows("pending_replies").catch(() => 0) : 0);

export async function defer({ id, comment }) {
  await enqueuePending({
    comment_id: String(comment.id), media: String(id), post_id: String(comment.postId || id),
    author_id: String(comment.authorId ?? ""), text: String(comment.text ?? "").slice(0, 500),
    comment_at: comment.at || new Date().toISOString(),
  });
}

// Send waiting comments while there is room (a few per call). `answer(row)` sends one; returns how many went out.
export async function drain(answer, { max = 5 } = {}) {
  if (!hasDb()) return 0;
  const room = Math.min(max, await roomLeft());
  if (room <= 0) return 0;
  let sent = 0;
  for (const row of await takePending(room)) {
    // a comment can only get a private reply within 7 days
    if (Date.now() - Date.parse(row.comment_at) > 6.9 * 864e5) continue;
    try { if (await answer(row)) sent++; }
    catch (e) {
      if (e.quotaFull) { await enqueuePending(row).catch(() => {}); break; }
      console.error("drain", row.comment_id, e.message);
    }
  }
  return sent;
}

export { takePending };
