// Caption of a post, for matching «فيديوهات جاية» rules when only the media id is known (a button tap).
// Uses the Instagram API when IG_ACCESS_TOKEN is set; otherwise rules match from the comment webhook's caption.
const env = (k, d = "") => process.env[k] ?? d;
const GRAPH = () => `https://graph.instagram.com/${env("GRAPH_VERSION", "v24.0")}`;
const captions = new Map(); // mediaId -> caption (per instance)

export async function getCaption(id) {
  if (captions.has(id)) return captions.get(id);
  if (!env("IG_ACCESS_TOKEN")) return "";
  try {
    const res = await fetch(`${GRAPH()}/${id}?fields=caption`, { headers: { Authorization: `Bearer ${env("IG_ACCESS_TOKEN")}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return "";
    captions.set(id, data.caption ?? "");
    return data.caption ?? "";
  } catch { return ""; }
}
