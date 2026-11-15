// Settings storage on Vercel Blob. Each save writes a new file under config/ and old ones are removed,
// so readers always get the newest version (no CDN cache issues).
import { put, list, del } from "@vercel/blob";

const PREFIX = "config/";
let cache = null, cacheAt = 0;

// Defaults copied from the old viaSocket flows.
export const DEFAULT_CONFIG = {
  enabled: true,
  // Public reply on the comment (one picked at random).
  commentReplies: [
    "📩 The link's in your DMs", "📨 Sent it to you privately 🙌", "📬 Message delivered to your DMs",
    "💌 Everything's in your messages", "📪 Link sent, hope you like the ideas 🔥", "🚀 The link's in your messages",
    "👾 The character sent you the link in DMs", "📩 Done, the link's in your messages", "🙌 Sent privately, good luck",
    "💬 Sent! The link's waiting in your DMs", "📩 Sent the link privately, got it?", "📨 Message sent, did you get it?",
    "📬 Sent, can't wait to hear what you think 👀", "📪 Got the link? If not, I'm here", "💌 Sent, tell me what you think of the tour",
    "📩 Sent! Hope it reached you ✌️", "📩 Check your DMs!", "🚀 Sent! It's in your inbox", "✨ Link sent privately",
    "👀 It's in your DMs now", "🔥 Just sent it, enjoy!", "💌 Sent you the link, let me know what you think",
    "✅ Done! Check your messages", "📬 Sent ✅ The link's in your DMs",
  ],
  // First private message (with the "Link" button). One picked at random.
  dmMessages: [
    "Here you go 👇 Tap LINK to get it 🔥", "Welcome 👋 Just tap the LINK button below", "Your link is ready 👇 Tap LINK 🧞‍♂️",
    "Glad you're here 😍 All the ideas are on the LINK button", "As promised 👇 Tap LINK to get it 🚀",
    "Hey 👾 Tap LINK below, can't wait to hear what you think", "Thanks for the comment ❤️ Tap LINK to get it",
    "Here's what you asked for 👇 Tap LINK 🔥", "Let's go 🎮 The tour starts from the LINK button",
    "The link's waiting below 👇 Tap LINK 😉", "Here's your link 👇 Tap LINK 🔥", "Hey 👋 Tap LINK below to get it",
    "Thanks for the comment ❤️ Tap LINK below", "As promised 👇 Tap LINK and enjoy 🚀", "Let's go 🎮 Tap LINK to start the tour",
    "Your link is ready 👇 Just tap LINK 🧞‍♂️",
  ],
  linkButtonTitle: "Link",
  // When they tap "Link": only followers get the actual URL.
  followGate: true,
  reactOnLink: true,
  followerReplies: [
    "Here's the link:", "The link:", "Here's the link 👇", "Link's ready 👇", "This is the link 🔥 👇", "Here's the link 👇",
    "The link 👾 👇", "Let's go from here 👇", "Here it is, coins are hidden everywhere 🪙 👇", "Here it is, good luck 🚀 👇",
    "Here's your link 👇", "Your link:", "Here you go 🔥 👇", "Enjoy the tour 🎮 👇", "Don't forget to find the coins 🪙 👇",
  ],
  urlButtonTitle: "دوس هنا",
  nonFollowerMessages: ["اعملي فولو عشان أعرف ابعتلك اللينك"],
  followingButtonTitle: "Following",
  // mediaId -> { enabled, link, keyword, dm, reply, caption, permalink }
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

export async function loadConfig({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < 20_000) return cache;
  if (!token()) return clone(DEFAULT_CONFIG);
  try {
    const { blobs } = await list({ prefix: PREFIX });
    if (!blobs.length) return (cache = clone(DEFAULT_CONFIG)), (cacheAt = Date.now()), cache;
    blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    const res = await fetch(blobs[0].url, { headers: { Authorization: `Bearer ${token()}` }, cache: "no-store" });
    const data = await res.json();
    cache = { ...clone(DEFAULT_CONFIG), ...data, posts: data.posts ?? {} };
    cacheAt = Date.now();
    return cache;
  } catch (e) {
    console.error("loadConfig failed", e?.message);
    return cache ?? clone(DEFAULT_CONFIG);
  }
}

const str = (v, max, d = "") => String(v ?? d).slice(0, max);
const arr = (v, d, maxItems = 100, maxLen = 600) => {
  const a = (Array.isArray(v) ? v : d).map((s) => String(s).trim()).filter(Boolean).slice(0, maxItems).map((s) => s.slice(0, maxLen));
  return a.length ? a : d;
};

export function cleanConfig(cfg) {
  const D = DEFAULT_CONFIG;
  const clean = {
    enabled: cfg.enabled !== false,
    commentReplies: arr(cfg.commentReplies, D.commentReplies, 100, 300),
    dmMessages: arr(cfg.dmMessages, D.dmMessages),
    linkButtonTitle: str(cfg.linkButtonTitle, 20, D.linkButtonTitle).trim() || D.linkButtonTitle,
    followGate: cfg.followGate !== false,
    reactOnLink: cfg.reactOnLink !== false,
    followerReplies: arr(cfg.followerReplies, D.followerReplies),
    urlButtonTitle: str(cfg.urlButtonTitle, 20, D.urlButtonTitle).trim() || D.urlButtonTitle,
    nonFollowerMessages: arr(cfg.nonFollowerMessages, D.nonFollowerMessages),
    followingButtonTitle: str(cfg.followingButtonTitle, 20, D.followingButtonTitle).trim() || D.followingButtonTitle,
    posts: {},
  };
  for (const [id, p] of Object.entries(cfg.posts ?? {})) {
    if (!/^\d+$/.test(id)) continue;
    clean.posts[id] = {
      enabled: !!p.enabled,
      link: str(p.link, 900).trim(),
      keyword: str(p.keyword, 200).trim(),
      dm: str(p.dm, 600),
      reply: str(p.reply, 300),
      caption: str(p.caption, 120),
      permalink: str(p.permalink, 300),
    };
  }
  return clean;
}

export async function saveConfig(cfg) {
  if (!token()) throw new Error("Blob storage is not connected (BLOB_READ_WRITE_TOKEN missing)");
  const clean = cleanConfig(cfg);
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
