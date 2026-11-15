// Self-test: makes one read call per permission so Meta's "testing requirements" are met,
// and shows whether the token works. Open: /api/selftest?key=<VERIFY_TOKEN>
// Returns only ok/status per call, never account data.
const env = (k, d = "") => process.env[k] ?? d;
const GRAPH = () => `https://graph.instagram.com/${env("GRAPH_VERSION", "v24.0")}`;

async function get(path) {
  const res = await fetch(`${GRAPH()}${path}`, { headers: { Authorization: `Bearer ${env("IG_ACCESS_TOKEN")}` } });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data, error: data?.error?.message };
}

export async function GET(request) {
  const key = new URL(request.url).searchParams.get("key");
  if (!env("VERIFY_TOKEN") || key !== env("VERIFY_TOKEN")) return new Response("Forbidden", { status: 403 });

  const out = {};
  const me = await get(`/me?fields=user_id,username`);
  out.basic = { ok: me.ok, status: me.status, error: me.error };

  const media = await get(`/me/media?fields=id&limit=1`);
  out.media = { ok: media.ok, status: media.status, error: media.error };

  const mediaId = media.data?.data?.[0]?.id;
  if (mediaId) {
    const c = await get(`/${mediaId}/comments?limit=1`);
    out.comments = { ok: c.ok, status: c.status, error: c.error };
  } else out.comments = { ok: false, error: "no posts found" };

  const conv = await get(`/me/conversations?platform=instagram&limit=1`);
  out.messages = { ok: conv.ok, status: conv.status, error: conv.error };

  return Response.json(out);
}
