// A tiny event log for the stats page, kept on Vercel Blob. Each event is an empty file whose path carries the
// data (events/<day>/<time>_<type>_<media>_<user>), so the stats read only the file listing, never the files.
//   first   first DM sent by the panel (button that checks the follow)
//   gate    a tap from someone who doesn't follow yet («follow first» sent)
//   link    real link sent by the panel (after a tap, or straight away)
//   click   someone opened a link the panel sent (through /api/go)
//   dm      answered a keyword sent in a DM
import crypto from "node:crypto";
import { put, list } from "@vercel/blob";
import { hasDb, insertEvent, selectEvents } from "./db.js";

export const TYPES = ["first", "gate", "link", "click", "dm"];
const token = () => process.env.BLOB_READ_WRITE_TOKEN;
const day = (t) => new Date(t).toISOString().slice(0, 10);
// "k:<key>" passes an already-hashed key through (the tracked link only knows the key)
export const userKey = (id) => /^k:[a-f0-9]{12}$/.test(String(id)) ? String(id).slice(2)
  : crypto.createHash("sha256").update(String(id ?? "")).digest("hex").slice(0, 12);

// Off unless EVENTS_BLOB=1: one Blob write per event used up Vercel's free Blob quota and got the store blocked.
const on = () => process.env.EVENTS_BLOB === "1";

export async function logEvent(type, media, user, at = Date.now()) {
  if (!TYPES.includes(type)) return;
  if (hasDb()) {
    try { await insertEvent({ at: new Date(at).toISOString(), type, media: String(media || "0").replace(/\D/g, "") || "0", user_key: userKey(user) }); }
    catch (e) { console.error("logEvent", e.message); }
    return;
  }
  if (!on() || !token()) return;
  const path = `events/${day(at)}/${at}_${type}_${String(media || "0").replace(/\D/g, "") || "0"}_${userKey(user)}`;
  try { await put(path, "", { access: "public", addRandomSuffix: true, contentType: "text/plain" }); }
  catch (e) { console.error("logEvent", e.message); }
}

// Events of the last `days` days: [{ at, day, type, media, user }]
export async function readEvents(days = 14, now = Date.now()) {
  if (hasDb()) {
    const since = new Date(new Date(now - (days - 1) * 864e5).toISOString().slice(0, 10) + "T00:00:00Z").toISOString();
    return (await selectEvents(since)).map((r) => {
      const t = Date.parse(r.at);
      return { at: t, day: new Date(t).toISOString().slice(0, 10), type: r.type, media: r.media, user: r.user_key };
    });
  }
  if (!on() || !token()) return [];
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = day(now - i * 864e5);
    let cursor;
    do {
      const r = await list({ prefix: `events/${d}/`, cursor, limit: 1000 });
      for (const b of r.blobs) {
        const name = b.pathname.split("/").pop();
        const [at, type, media, user] = name.split("_");
        if (TYPES.includes(type)) out.push({ at: Number(at), day: d, type, media, user: (user || "").slice(0, 12) });
      }
      cursor = r.hasMore ? r.cursor : undefined;
    } while (cursor);
  }
  return out;
}
