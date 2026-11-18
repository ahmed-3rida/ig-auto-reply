// «حالة النظام»: is everything working, and what got lost. Each check is green / yellow / red with a line of text.
import { accountHealth, webhookLogs, listAutomations, automationLogs, hasZernio } from "./zernio.js";
import { readEvents } from "./events.js";

const H = 3600e3;
const parse = (s) => { try { return JSON.parse(s ?? ""); } catch { return {}; } };

export async function health(cfg, { now = Date.now() } = {}) {
  const checks = [];
  const add = (key, level, title, detail, at) => checks.push({ key, level, title, detail, at: at ?? null });
  if (!hasZernio()) {
    add("zernio", "red", "Zernio مش متوصل", "ZERNIO_API_KEY مش متضاف في Vercel.");
    return { checks, lost: [], level: "red" };
  }

  // 1) Zernio + the Instagram account
  let acc = null;
  try {
    acc = await accountHealth();
    const lvl = acc.status === "healthy" && acc.tokenStatus?.valid !== false ? "green" : acc.status === "warning" ? "yellow" : "red";
    const exp = acc.tokenStatus?.expiresIn ? ` · الربط صالح ${acc.tokenStatus.expiresIn.replace("days", "يوم")}` : "";
    add("zernio", lvl, lvl === "green" ? "Zernio والحساب شغالين" : "فيه مشكلة في ربط الحساب",
      (acc.issues?.[0]?.message ?? acc.issues?.[0] ?? (lvl === "green" ? "@" + acc.username + exp : "")) || "", null);
  } catch (e) {
    add("zernio", "red", "مقدرتش أوصل لـ Zernio", e.message);
  }

  // 2) the webhook: deliveries in the last 24h
  let logs = [];
  try { logs = (await webhookLogs({ limit: "100" })).logs ?? []; } catch (e) { add("webhook", "red", "مقدرتش أقرا سجل الـ webhook", e.message); }
  const recent = logs.filter((l) => now - Date.parse(l.createdAt) < 24 * H);
  const failed = recent.filter((l) => l.status === "failed");
  const lastOk = logs.find((l) => l.status === "success");
  if (logs.length || !checks.some((c) => c.key === "webhook")) {
    if (!logs.length) add("webhook", "yellow", "الـ webhook ما استلمش حاجة", "اتأكد إنه متضاف في Zernio بالحدثين comment.received و message.received.");
    else {
      const rate = recent.length ? failed.length / recent.length : 0;
      add("webhook", failed.length === 0 ? "green" : rate > 0.2 ? "red" : "yellow",
        failed.length ? `الـ webhook فشل ${failed.length} مرة في آخر 24 ساعة` : "الـ webhook شغال",
        failed[0] ? "آخر غلط: " + (failed[0].errorMessage || failed[0].statusCode || "") : `${recent.length} طلب في آخر 24 ساعة`, lastOk?.createdAt);
    }
  }

  // 3) last comment received / last DM received
  const lastComment = logs.find((l) => l.event === "comment.received")?.createdAt ?? acc?.inboundActivity?.lastCommentAt;
  const lastMsg = logs.find((l) => l.event === "message.received")?.createdAt ?? acc?.inboundActivity?.lastMessageAt;
  add("inbound", lastComment && now - Date.parse(lastComment) < 48 * H ? "green" : "yellow", "آخر كومنت وصل",
    lastMsg ? "آخر رسالة في الخاص: " + lastMsg : "", lastComment);

  // 4) last reply sent (panel events + Zernio automations)
  let lastReply = null;
  try {
    const ev = (await readEvents(2, now)).filter((e) => ["first", "link", "dm", "gate"].includes(e.type));
    if (ev.length) lastReply = Math.max(...ev.map((e) => e.at));
  } catch {}
  try {
    for (const a of (await listAutomations()).filter((a) => a.stats?.triggered).slice(0, 12)) {
      const l = (await automationLogs(a._id ?? a.id, 5)).find((x) => ["sent", "gated"].includes(x.status));
      if (l) lastReply = Math.max(lastReply ?? 0, Date.parse(l.createdAt));
    }
  } catch {}
  const replyAt = lastReply ? new Date(lastReply).toISOString() : null;
  const behind = lastComment && (!lastReply || Date.parse(lastComment) - lastReply > 2 * H);
  add("reply", !lastReply ? "yellow" : behind ? "yellow" : "green", "آخر رد اتبعت",
    behind ? "فيه كومنتات أحدث من آخر رد بأكتر من ساعتين — جرّب «رد على الكومنتات اللي فاتت»." : "", replyAt);

  // 5) taps / keyword DMs we couldn't answer because another app holds the chat
  const lost = logs
    .filter((l) => l.event === "message.received" && now - Date.parse(l.createdAt) < 24 * H && parse(l.responseBody).skipped === "standby")
    .map((l) => {
      const p = l.requestPayload ?? {};
      return { at: l.createdAt, user: p.message?.sender?.username || p.conversation?.participantUsername || "", text: p.metadata?.postbackTitle || p.message?.text || "" };
    });
  const users = new Set(lost.map((x) => x.user));
  add("lost", lost.length === 0 ? "green" : "red",
    lost.length ? `${lost.length} دوسة/رسالة ضاعت من ${users.size} شخص في آخر 24 ساعة` : "مفيش دوسات ضاعت في آخر 24 ساعة",
    lost.length ? "تطبيق تاني ماسك المحادثات دي، فمحدش يقدر يرد فيها. خلّي Zernio التطبيق الأساسي للرسايل في إنستجرام." : "");

  // 6) videos Zernio refused
  const refused = Object.entries(cfg.posts).filter(([, p]) => p.enabled && p.syncError);
  add("sync", refused.length ? "red" : "green", refused.length ? `Zernio رفض ${refused.length} فيديو` : "كل الفيديوهات متزامنة مع Zernio",
    refused[0] ? refused[0][1].syncError : "");

  const level = checks.some((c) => c.level === "red") ? "red" : checks.some((c) => c.level === "yellow") ? "yellow" : "green";
  return { checks, lost: lost.slice(0, 30), level, at: new Date(now).toISOString() };
}
