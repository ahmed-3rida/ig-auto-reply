// Public liveness check (no secrets): where the settings are read from, and their shape.
import { loadConfig, storageState } from "../lib/config.js";

export async function GET() {
  const out = { blobToken: !!process.env.BLOB_READ_WRITE_TOKEN, loaded: null };
  try {
    const cfg = await loadConfig();
    const posts = Object.values(cfg.posts);
    out.loaded = { enabled: cfg.enabled, posts: posts.length, on: posts.filter((p) => p.enabled).length,
      gateOn: posts.filter((p) => p.gate).length, withAutomation: posts.filter((p) => p.automationId).length };
  } catch (e) { out.loaded = { error: String(e.message).slice(0, 200) }; }
  out.source = storageState.source; out.storageError = storageState.error || null;
  return Response.json(out, { headers: { "Cache-Control": "no-store" } });
}
