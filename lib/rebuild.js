// When the saved settings can't be read (e.g. Vercel blocked the Blob store), rebuild them from Zernio:
// every video's automation carries its link, button, texts, follow check and trigger words, so the replies
// keep working exactly as last synced. Only the global texts Zernio doesn't hold fall back to the defaults.
import { listAutomations } from "./zernio.js";
import { cleanConfig, DEFAULT_SETTINGS } from "./config.js";
import { adoptExternal } from "./sync.js";

export async function rebuildFromZernio() {
  const autos = await listAutomations();
  const link = autos.find((a) => (a.buttons ?? []).some((b) => b.type === "url") && a.dmMessage);
  const settings = { ...DEFAULT_SETTINGS };
  if (link) settings.linkDm = [link.dmMessage, ...(link.dmMessageVariations ?? [])].join("\n");
  const gateMsg = autos.find((a) => a.followGate?.message)?.followGate.message;
  if (gateMsg) settings.firstDm = [gateMsg, ...DEFAULT_SETTINGS.firstDm.split("\n").filter((l) => l !== gateMsg)].slice(0, 6).join("\n");
  const any = autos[0];
  if (any) {
    settings.repeat = any.repeatPolicy?.mode === "once" ? "once" : "every";
    settings.gateStyle = any.audience?.whenUnknown === "verify" ? "follow" : "link";
    const r = [any.commentReply, ...(any.commentReplyVariations ?? [])].filter(Boolean);
    if (r.length) settings.reply = r.join("\n");
  }
  const cfg = cleanConfig({ enabled: autos.some((a) => a.isActive), settings, posts: {}, rules: [] });
  adoptExternal(cfg, autos);
  // replies that equal the global ones belong to the settings, not to each video
  for (const p of Object.values(cfg.posts)) if (p.reply === settings.reply) p.reply = "";
  return cfg;
}
