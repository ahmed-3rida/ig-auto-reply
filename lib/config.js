// Settings storage on Vercel Blob. Each save writes a new file under config/ and old ones are removed,
// so readers always get the newest version (no CDN cache issues).
import { put, list, del } from "@vercel/blob";

const PREFIX = "config/";
let cache = null, cacheAt = 0;

export const DEFAULT_CONFIG = {
  enabled: true,
  defaultDm: "أهلاً {username} 👋\nده الرابط: {link}",
  defaultReply: "بعتلك الرابط في الخاص ❤️",
  posts: {}, // mediaId -> { enabled, link, keyword, dm, reply, caption, permalink }
};

const token = () => process.env.BLOB_READ_WRITE_TOKEN;

export async function loadConfig({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < 20_000) return cache;
  if (!token()) return { ...DEFAULT_CONFIG };
  try {
    const { blobs } = await list({ prefix: PREFIX });
    if (!blobs.length) return (cache = { ...DEFAULT_CONFIG }), (cacheAt = Date.now()), cache;
    blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    const res = await fetch(blobs[0].url, { headers: { Authorization: `Bearer ${token()}` }, cache: "no-store" });
    const data = await res.json();
    cache = { ...DEFAULT_CONFIG, ...data, posts: data.posts ?? {} };
    cacheAt = Date.now();
    return cache;
  } catch (e) {
    console.error("loadConfig failed", e?.message);
    return cache ?? { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(cfg) {
  if (!token()) throw new Error("Blob storage is not connected (BLOB_READ_WRITE_TOKEN missing)");
  const clean = {
    enabled: cfg.enabled !== false,
    defaultDm: String(cfg.defaultDm ?? DEFAULT_CONFIG.defaultDm).slice(0, 1000),
    defaultReply: String(cfg.defaultReply ?? DEFAULT_CONFIG.defaultReply).slice(0, 300),
    posts: {},
  };
  for (const [id, p] of Object.entries(cfg.posts ?? {})) {
    if (!/^\d+$/.test(id)) continue;
    clean.posts[id] = {
      enabled: !!p.enabled,
      link: String(p.link ?? "").trim().slice(0, 500),
      keyword: String(p.keyword ?? "").trim().slice(0, 200),
      dm: String(p.dm ?? "").slice(0, 1000),
      reply: String(p.reply ?? "").slice(0, 300),
      caption: String(p.caption ?? "").slice(0, 120),
      permalink: String(p.permalink ?? "").slice(0, 300),
    };
  }
  const body = JSON.stringify(clean);
  const path = `${PREFIX}${Date.now()}.json`;
  const opts = { contentType: "application/json", addRandomSuffix: false };
  try {
    await put(path, body, { ...opts, access: "public" });
  } catch (e) {
    if (!/private/i.test(e?.message ?? "")) throw e;
    await put(path, body, { ...opts, access: "private" });
  }
  // keep the newest 5 versions
  const { blobs } = await list({ prefix: PREFIX });
  blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  const old = blobs.slice(5).map((b) => b.url);
  if (old.length) await del(old).catch(() => {});
  cache = clean;
  cacheAt = Date.now();
  return clean;
}
