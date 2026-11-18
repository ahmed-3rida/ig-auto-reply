// Public liveness check (no secrets): can the site read its saved settings?
import { list } from "@vercel/blob";

export async function GET() {
  const out = { blobToken: !!process.env.BLOB_READ_WRITE_TOKEN, list: null, error: null, configFiles: null };
  try {
    const r = await list({ prefix: "config/", limit: 10 });
    out.list = "ok"; out.configFiles = r.blobs.length;
  } catch (e) {
    out.list = "failed"; out.error = String(e?.message ?? e).slice(0, 300);
  }
  return Response.json(out, { headers: { "Cache-Control": "no-store" } });
}
