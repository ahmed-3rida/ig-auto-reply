// A video's word read from its caption: «اكتب IDM في الكومنت» -> "IDM". Used to answer that word in DMs
// when the video has no trigger words of its own. Captions come from Zernio (cached for 10 minutes).
import { listPosts } from "./zernio.js";

export function captionKeyword(caption = "") {
  const m = String(caption).match(/اكتب\s+[«"'“]?([^\s«»"'“”]{2,30})[»"'”]?\s+(?:في|ف)\s*(?:ال)?(?:كومنت|كومنتات|تعليق|تعليقات)/i);
  return m ? m[1].replace(/[.,!؟?،]+$/, "") : "";
}

let cache = null, at = 0;
export async function autoKeywords({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - at < 10 * 60e3) return cache;
  const map = new Map();
  let after = null, pages = 0;
  do {
    const d = await listPosts(after);
    for (const p of d.items) { const k = captionKeyword(p.content); if (k) map.set(String(p.id), k); }
    after = d.after; pages++;
  } while (after && pages < 3);
  cache = map; at = Date.now();
  return map;
}
export const _resetAuto = () => { cache = null; };
