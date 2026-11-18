// Settings storage on Vercel Blob: which videos are active and the link for each one.
// viaSocket reads the link through /api/link. Each save writes a new file under config/
// and old ones are removed, so readers always get the newest version.
import { put, list, del } from "@vercel/blob";

const PREFIX = "config/";
let cache = null, cacheAt = 0;

// Texts Zernio uses for every video (editable in the panel under «إعدادات عامة»).
export const DEFAULT_SETTINGS = {
  reply: "بعتلك في الخاص 📩",                 // public reply under the comment (when a video has none)
  linkDm: "اتفضل اللينك 👇",                  // DM text above the link button when the reply type is «لينك»
  gateMessage: "اعمل فولو للحساب الأول، وبعدها دوس على الزرار تحت وهبعتلك اللينك 👇",
  gateButton: "عملت فولو ✅",
  profileButton: "افتح الحساب",
  notFollowing: "لسه مش عامل فولو 👀 اعمل فولو للحساب ودوس على الزرار تاني وهيوصلك اللينك.",
};

export const DEFAULT_CONFIG = {
  enabled: true,
  settings: { ...DEFAULT_SETTINGS },
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

// Arabic-friendly normalization used to match caption phrases.
export function normalize(s = "") {
  return String(s).toLowerCase().replace(/[\u064B-\u0652\u0640]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/\s+/g, " ").trim();
}

// Rules are for videos that don't exist yet (scheduled): "caption contains <match>" -> link.
export function findRule(caption, rules = []) {
  const c = normalize(caption);
  if (!c) return null;
  let best = null;
  for (const r of rules) {
    const m = normalize(r.match);
    if (r.enabled && m && c.includes(m) && /^https?:\/\//i.test(r.link) && (!best || m.length > normalize(best.match).length)) best = r;
  }
  return best;
}

// ---- v2: a reply can be a link, a message, or a message + link button ----
export const MODES = ["link", "message", "both"];
export const DEFAULT_BUTTON = "Link";
const isLink = (s) => /^https?:\/\/\S+$/i.test(String(s ?? "").trim());

// What a post/rule actually sends, or null if it has nothing usable.
// "both" without a link acts as "message"; "both" without a message acts as "link".
export function effective(e) {
  if (!e || e.enabled === false) return null;
  const link = isLink(e.link) ? String(e.link).trim() : "";
  const message = String(e.message ?? "").trim();
  const mode = MODES.includes(e.mode) ? e.mode : "link";
  let m = null;
  if (mode === "link") m = link ? "link" : null;
  else if (mode === "message") m = message ? "message" : null;
  else m = link && message ? "both" : message ? "message" : link ? "link" : null;
  if (!m) return null;
  return { mode: m, link: m === "message" ? "" : link, message: m === "link" ? "" : message, button: String(e.button ?? "").trim() || DEFAULT_BUTTON };
}

// Like findRule, but a rule may be message-only.
export function findRuleV2(caption, rules = []) {
  const c = normalize(caption);
  if (!c) return null;
  let best = null;
  for (const r of rules) {
    const m = normalize(r.match);
    if (m && c.includes(m) && effective(r) && (!best || m.length > normalize(best.match).length)) best = r;
  }
  return best;
}

const cleanMode = (v) => (MODES.includes(v) ? v : "link");
// Instagram limits: text message 1000 chars, button title 20 chars.
const v2Fields = (o) => ({
  mode: cleanMode(o?.mode), message: str(o?.message, 1000).replace(/\r\n/g, "\n"), button: str(o?.button, 20).trim(),
  // v3 (Zernio): trigger words (comma separated, empty = any comment), public reply (one per line = random pick),
  // follow check on/off
  keywords: str(o?.keywords, 300).trim(),
  matchMode: ["contains", "word", "exact"].includes(o?.matchMode) ? o.matchMode : "contains",
  reply: str(o?.reply, 1000).replace(/\r\n/g, "\n"),
  gate: o?.gate !== false,
});

export function cleanSettings(s = {}) {
  const out = {};
  for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
    const max = /Button$/.test(k) ? 20 : 640;
    const v = str(s?.[k], max).replace(/\r\n/g, "\n").trim();
    out[k] = v || def;
  }
  return out;
}

export function cleanConfig(cfg = {}) {
  const clean = { enabled: cfg.enabled !== false, settings: cleanSettings(cfg.settings), posts: {}, rules: [] };
  for (const r of Array.isArray(cfg.rules) ? cfg.rules.slice(0, 200) : []) {
    const match = str(r?.match, 120).trim();
    if (!match) continue;
    clean.rules.push({ id: str(r.id || Date.now() + Math.random(), 40), match, link: str(r.link, 900).trim(), enabled: r.enabled !== false, note: str(r.note, 120), ...v2Fields(r) });
  }
  for (const [id, p] of Object.entries(cfg.posts ?? {})) {
    if (!/^\d+$/.test(id) || !p) continue;
    clean.posts[id] = {
      enabled: !!p.enabled,
      link: str(p.link, 900).trim(),
      caption: str(p.caption, 120),
      permalink: str(p.permalink, 300),
      ...v2Fields(p),
      // Zernio bookkeeping, written by the server only (see lib/sync.js)
      automationId: /^[a-f0-9]{24}$/.test(p.automationId ?? "") ? p.automationId : "",
      syncedHash: str(p.syncedHash, 64),
      syncError: str(p.syncError, 300),
      via: str(p.via, 120),
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
    cache = cleanConfig({ enabled: data.enabled, settings: data.settings, rules: data.rules, posts: { ...clone(DEFAULT_CONFIG.posts), ...(data.posts ?? {}) } });
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
