// Minimal Zernio REST client. Zernio is the one that answers comments, sends the DMs and runs the follow check;
// the panel only tells it what to do for each video (one Zernio "comment automation" per video).
//
// Env: ZERNIO_API_KEY (required), ZERNIO_ACCOUNT_ID / ZERNIO_PROFILE_ID (optional: the first connected
// Instagram account and its profile are used when they are not set).
const env = (k, d = "") => process.env[k] ?? d;
const BASE = () => env("ZERNIO_API_BASE", "https://zernio.com/api").replace(/\/$/, "");

export const hasZernio = () => !!env("ZERNIO_API_KEY");

export class ZernioError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}

export async function zernio(method, path, body) {
  if (!hasZernio()) throw new ZernioError("ZERNIO_API_KEY is not set", 500);
  const res = await fetch(BASE() + path, {
    method,
    headers: { Authorization: `Bearer ${env("ZERNIO_API_KEY")}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || (typeof data?.error === "string" ? data.error : "") || `Zernio ${res.status}`;
    throw new ZernioError(msg, res.status, data);
  }
  return data;
}

let ids = null;
// { accountId, profileId } of the Instagram account the panel manages.
export async function account() {
  if (ids) return ids;
  let accountId = env("ZERNIO_ACCOUNT_ID"), profileId = env("ZERNIO_PROFILE_ID");
  if (!accountId || !profileId) {
    const d = await zernio("GET", "/v1/accounts?platform=instagram&limit=50");
    const list = d.accounts ?? d.data ?? [];
    const a = list.find((x) => (x._id ?? x.id) === accountId) ?? list[0];
    if (!a) throw new ZernioError("No Instagram account is connected to Zernio", 404);
    accountId = a._id ?? a.id;
    profileId = profileId || (typeof a.profileId === "object" ? a.profileId?._id : a.profileId);
  }
  ids = { accountId, profileId };
  return ids;
}

export const listAutomations = async () => {
  const { profileId } = await account();
  const d = await zernio("GET", `/v1/comment-automations?profileId=${encodeURIComponent(profileId)}`);
  return d.automations ?? [];
};
export const createAutomation = async (body) => {
  const { accountId, profileId } = await account();
  return (await zernio("POST", "/v1/comment-automations", { profileId, accountId, ...body })).automation;
};
export const updateAutomation = async (id, body) => (await zernio("PATCH", `/v1/comment-automations/${encodeURIComponent(id)}`, body)).automation;
export const deleteAutomation = (id) => zernio("DELETE", `/v1/comment-automations/${encodeURIComponent(id)}`);

// Posts of the account (newest first) for the panel grid.
export async function listPosts(cursor) {
  const { accountId } = await account();
  const q = new URLSearchParams({ accountId, platform: "instagram", view: "full", limit: "24", sortBy: "date", sortOrder: "desc" });
  if (cursor) q.set("cursor", cursor);
  const d = await zernio("GET", `/v1/inbox/comments?${q}`);
  return { items: d.data ?? [], after: d.pagination?.hasMore ? d.pagination.nextCursor : null };
}

export const privateReply = async (postId, commentId, message, buttons) => {
  const { accountId } = await account();
  return zernio("POST", `/v1/inbox/comments/${encodeURIComponent(postId)}/${encodeURIComponent(commentId)}/private-reply`, { accountId, message, ...(buttons?.length ? { buttons } : {}) });
};
export const publicReply = async (postId, commentId, message) => {
  const { accountId } = await account();
  return zernio("POST", `/v1/inbox/comments/${encodeURIComponent(postId)}`, { accountId, message, commentId });
};

export const _reset = () => { ids = null; }; // tests
