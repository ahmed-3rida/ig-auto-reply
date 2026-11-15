// Settings storage on Vercel Blob: which videos are active and the link for each one.
// viaSocket reads the link through /api/link. Each save writes a new file under config/
// and old ones are removed, so readers always get the newest version.
import { put, list, del } from "@vercel/blob";

const PREFIX = "config/";
let cache = null, cacheAt = 0;

export const DEFAULT_CONFIG = {
  enabled: true,
  // mediaId -> { enabled, link, caption, permalink }  (the 12 videos from the old viaSocket flow)
  posts: {
    "17988282846093039": { enabled: true, link: "https://dev.uniskills.pro/" },
    "17911719594594038": { enabled: true, link: "https://dev.uniskills.pro/" },
    "18237667327323280": { enabled: true, link: "https://dev.uniskills.pro/" },
    "17994969255111624": { enabled: true, link: "https://dev.uniskills.pro/" },
    "17977825794155993": { enabled: true, link: "https://woolen-molybdenum-8eb.notion.site/410c2f80bc838148be15c9c949054eea" },
    "18109244239980922": { enabled: true, link: "https://woolen-molybdenum-8eb.notion.site/AI-25-410c2f80bc83811fa39df86d0ed16839" },
    "18131996188887143": { enabled: true, link: "https://woolen-molybdenum-8eb.notion.site/Checklist-15-410c2f80bc8381579272c1424307b5b5" },
    "17980333533150089": { enabled: true, link: "https://localsend.org" },
    "18171902602486105": { enabled: true, link: "https://woolen-molybdenum-8eb.notion.site/Enter-410c2f80bc83815cbc84d18fdacb4d6c?source=copy_link" },
    "18086660576368666": { enabled: true, link: "https://woolen-molybdenum-8eb.notion.site/5-Agents-Automations-410c2f80bc838133b7e3dfb266091745?source=copy_link" },
    "18103119482424684": { enabled: true, link: "https://misterdownloadmanager.com/" },
    "17978249321939264": { enabled: true, link: "https://github.com/mutonby/openshorts" },
  },
};

const token = () => process.env.BLOB_READ_WRITE_TOKEN;
const clone = (o) => JSON.parse(JSON.stringify(o));
const str = (v, max) => String(v ?? "").slice(0, max);

export function cleanConfig(cfg = {}) {
  const clean = { enabled: cfg.enabled !== false, posts: {} };
  for (const [id, p] of Object.entries(cfg.posts ?? {})) {
    if (!/^\d+$/.test(id) || !p) continue;
    clean.posts[id] = {
      enabled: !!p.enabled,
      link: str(p.link, 900).trim(),
      caption: str(p.caption, 120),
      permalink: str(p.permalink, 300),
    };
  }
  return clean;
}

export async function loadConfig({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < 20_000) return cache;
  if (!token()) return clone(DEFAULT_CONFIG);
  try {
    const { blobs } = await list({ prefix: PREFIX });
    let data = {};
    if (blobs.length) {
      blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
      const res = await fetch(blobs[0].url, { headers: { Authorization: `Bearer ${token()}` }, cache: "no-store" });
      data = await res.json();
    }
    // Old viaSocket videos stay available unless the panel has its own entry for them (turning one off saves enabled:false).
    cache = cleanConfig({ enabled: data.enabled, posts: { ...clone(DEFAULT_CONFIG.posts), ...(data.posts ?? {}) } });
    cacheAt = Date.now();
    return cache;
  } catch (e) {
    console.error("loadConfig failed", e?.message);
    return cache ?? clone(DEFAULT_CONFIG);
  }
}

export async function saveConfig(cfg) {
  if (!token()) throw new Error("Blob storage is not connected (BLOB_READ_WRITE_TOKEN missing)");
  const clean = cleanConfig(cfg);
  const path = `${PREFIX}${Date.now()}.json`;
  await put(path, JSON.stringify(clean), { contentType: "application/json", addRandomSuffix: false, access: "public" });
  // keep the newest 5 versions
  const { blobs } = await list({ prefix: PREFIX });
  blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  const old = blobs.slice(5).map((b) => b.url);
  if (old.length) await del(old).catch(() => {});
  cache = clean;
  cacheAt = Date.now();
  return clean;
}
