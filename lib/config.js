// Settings storage on Vercel Blob: which videos are active and what each one sends. Each save writes a new file under config/
// and old ones are removed, so readers always get the newest version.
import { put, list } from "@vercel/blob";

const PREFIX = "config/";
// The settings live in one file that is overwritten on save and read by its public URL. Reads by URL are
// "simple" Blob operations served from the CDN; list() is an "advanced" one with a small free quota (calling it
// on every webhook got the store blocked once), so it is only used to find files saved the old way.
const CURRENT = PREFIX + "current.json";
const storeBase = () => {
  const m = String(token() ?? "").match(/^vercel_blob_rw_([A-Za-z0-9]+)_/);
  return m ? `https://${m[1].toLowerCase()}.public.blob.vercel-storage.com` : "";
};
let cache = null, cacheAt = 0;

// Texts Zernio uses for every video (editable in the panel under «إعدادات عامة»).
export const DEFAULT_SETTINGS = {
  // public reply under the comment when a video has none; one per line = a random one each time (max 6)
  reply: "بعتلك في الخاص 📩\nشوف رسايلك 👀\nتم الإرسال ✅",
  // DM text above the real link button (reply type «لينك»); one per line = a random one each time (max 6)
  linkDm: [
    "اتفضل اللينك 👇",
    "ده اللينك اللي طلبته 🔗",
    "زي ما وعدتك 😉 اللينك تحت 👇",
    "اتفضل يا صاحبي 🔥 دوس على الزرار",
    "اللينك جاهز 👇 بالتوفيق 🚀",
    "تحت يا باشا 👇 لو عجبك شاركه مع صحابك",
  ].join("\n"),
  // first DM in the "link" style: its button checks the follow before the real link is sent (one per line, max 6)
  firstDm: [
    "دوس على الزرار تحت وهبعتلك اللينك 👇",
    "اضغط على الزرار وهيوصلك اللينك على طول 👇",
    "خطوة واحدة 👇 دوس على الزرار وخد اللينك",
    "اللينك مستنيك 👇 دوس على الزرار",
    "تمام 👌 دوس على الزرار تحت عشان توصلك",
    "قربت 🔥 دوس على الزرار وهبعتهولك",
  ].join("\n"),
  gateMessage: "اعمل فولو للحساب الأول، وبعدها دوس على الزرار تحت وهبعتلك اللينك 👇",
  gateButton: "عملت فولو ✅",
  profileButton: "افتح الحساب",
  notFollowing: "لسه مش عامل فولو 👀 اعمل فولو للحساب ودوس على الزرار تاني وهيوصلك اللينك.",
  // First DM to someone whose follow Instagram won't reveal yet (most new commenters):
  //   "link":   looks like the link itself — the link text + a button named like the video's link button.
  //             The tap checks the follow; a follower gets the real link button, others «follow first».
  //   "follow": asks to follow first (gateMessage + «عملت فولو» + open-profile button).
  gateStyle: "link",
  // "every": every matching comment gets the DM + public reply; "once": only a person's first comment per video
  repeat: "every",
  // answer a video's word when it is sent in a DM, for every video (each video can also turn it on alone)
  dmAll: true,
  textsV2: true, // see cleanSettings
};
export const GATE_STYLES = ["link", "follow"];

export const DEFAULT_CONFIG = {
  enabled: true,
  settings: { ...DEFAULT_SETTINGS },
  // the 12 videos that were set up before the panel (kept so they stay on until the panel has its own entry)
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

// Rules are for videos that don't exist yet (scheduled): "caption contains <match>" -> reply. Longest match wins.
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
  // also answer the trigger word when it is sent in a DM (needs trigger words)
  dmKeywords: !!o?.dmKeywords,
});

// One-time upgrade to several texts: a saved one-line linkDm / firstDm (from before texts could rotate) keeps
// its line first and gets the other default lines after it (6 in all). `textsV2` marks it done, so a single
// text chosen later stays single.
export function cleanSettings(s = {}) {
  const out = {};
  s = { ...s };
  if (!s.textsV2) {
    for (const k of ["linkDm", "firstDm"]) {
      const mine = String(s[k] ?? "").trim();
      if (!mine) continue;
      if (!mine.includes("\n")) {
        const rest = DEFAULT_SETTINGS[k].split("\n").filter((l) => l.trim() !== mine);
        s[k] = [mine, ...rest].slice(0, 6).join("\n");
      }
    }
  }
  for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
    if (k === "gateStyle") { out[k] = GATE_STYLES.includes(s?.[k]) ? s[k] : def; continue; }
    if (k === "textsV2") { out[k] = true; continue; }
    if (k === "dmAll") { out[k] = s?.[k] !== false; continue; }
    if (k === "repeat") { out[k] = ["every", "once"].includes(s?.[k]) ? s[k] : def; continue; }
    const max = /Button$/.test(k) ? 20 : ["reply", "linkDm", "firstDm"].includes(k) ? 1000 : 640;
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

// Where the last loadConfig got its data: "blob", "zernio" (Blob unreadable, rebuilt from Zernio) or "default".
export const storageState = { source: "blob", error: "" };

export async function loadConfig({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < 60_000) return cache;
  if (!token()) return clone(DEFAULT_CONFIG);
  try {
    let data = null;
    const base = storeBase();
    if (base) {
      const res = await fetch(`${base}/${CURRENT}`, { cache: "no-store" });
      if (res.ok) data = await res.json();
      else if (res.status !== 404) throw new Error(`Blob ${res.status}: ${(await res.text().catch(() => "")).trim().slice(0, 100)}`);
    }
    if (!data) {
      // saved the old way (config/<time>.json), or the token has an unexpected shape: find the newest file
      const { blobs } = await list({ prefix: PREFIX });
      data = {};
      if (blobs.length) {
        blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
        const res = await fetch(blobs[0].url, { cache: "no-store" });
        if (!res.ok) throw new Error(`Blob ${res.status}: ${(await res.text().catch(() => "")).trim().slice(0, 100)}`);
        data = await res.json();
      }
    }
    storageState.source = "blob"; storageState.error = "";
    // Old viaSocket videos stay available unless the panel has its own entry for them (turning one off saves enabled:false).
    cache = cleanConfig({ enabled: data.enabled, settings: data.settings, rules: data.rules, posts: { ...clone(DEFAULT_CONFIG.posts), ...(data.posts ?? {}) } });
    cacheAt = Date.now();
    return cache;
  } catch (e) {
    console.error("loadConfig failed", e?.message);
    storageState.error = String(e?.message ?? e).slice(0, 200);
    // Never answer from the built-in defaults while real settings exist somewhere: rebuild them from Zernio.
    try {
      const { rebuildFromZernio } = await import("./rebuild.js");
      cache = await rebuildFromZernio(); cacheAt = Date.now(); storageState.source = "zernio";
      return cache;
    } catch (e2) {
      console.error("rebuild from Zernio failed", e2?.message);
      if (cache) return cache;
      storageState.source = "default";
      throw new Error("مقدرتش أقرا الإعدادات: " + storageState.error);
    }
  }
}

export async function saveConfig(cfg) {
  if (!token()) throw new Error("Blob storage is not connected (BLOB_READ_WRITE_TOKEN missing)");
  const clean = cleanConfig(cfg);
  // one write per save; the CDN may serve the previous version for up to a minute
  await put(CURRENT, JSON.stringify(clean), { contentType: "application/json", addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60, access: "public" });
  cache = clean;
  cacheAt = Date.now();
  return clean;
}
