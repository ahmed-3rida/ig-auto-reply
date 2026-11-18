// Numbers for the stats tab: per video and per day, from Zernio (what its automations sent, and clicks on
// its tracked links) plus the panel's own event log (first DMs, follow checks, links sent after a tap, clicks).
import { listAutomations, automationLogs } from "./zernio.js";
import { readEvents } from "./events.js";

const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

export async function stats(cfg, { days = 14, now = Date.now() } = {}) {
  const [autos, events] = await Promise.all([listAutomations(), readEvents(days, now)]);
  const since = now - days * 864e5;
  const dayList = Array.from({ length: days }, (_, i) => dayOf(now - (days - 1 - i) * 864e5));
  const daily = Object.fromEntries(dayList.map((d) => [d, { day: d, answered: 0, links: 0, clicks: 0, follows: 0 }]));
  const videos = {};
  const v = (id) => (videos[id] ??= { id, caption: cfg.posts[id]?.caption ?? "", answered: 0, links: 0, clicks: 0, started: 0, converted: 0 });

  // Zernio: totals per video (all time) and, from its logs, per day
  for (const a of autos) {
    if (!a.platformPostId) continue;
    const s = a.stats ?? {}, row = v(a.platformPostId);
    row.answered += (s.dmsSent ?? 0) + (s.followGateSent ?? 0);
    row.links += s.dmsSent ?? 0;
    row.clicks += s.linkClicks ?? 0;
    if (!s.triggered) continue;
    const logs = await automationLogs(a._id ?? a.id, 100).catch(() => []);
    for (const l of logs) {
      const t = Date.parse(l.createdAt);
      if (t >= since && daily[dayOf(t)] && ["sent", "gated"].includes(l.status)) {
        daily[dayOf(t)].answered++;
        if (l.status === "sent") daily[dayOf(t)].links++;
      }
      const ct = Date.parse(l.clickedAt ?? "");
      if (ct >= since && daily[dayOf(ct)]) daily[dayOf(ct)].clicks++;
    }
  }

  // Panel events (last `days` days)
  const firstAt = new Map(); // `${media}|${user}` -> first time they were asked to tap / follow
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    const row = v(e.media), d = daily[e.day];
    const k = `${e.media}|${e.user}`;
    if (e.type === "first" || e.type === "gate") {
      if (!firstAt.has(k)) { firstAt.set(k, e.at); row.started++; }
      if (e.type === "first") { row.answered++; if (d) d.answered++; }
    } else if (e.type === "link" || e.type === "dm") {
      row.links++; if (d) d.links++;
      if (e.type === "dm") { row.answered++; if (d) d.answered++; }
      if (firstAt.has(k) && firstAt.get(k) !== -1) { row.converted++; firstAt.set(k, -1); if (d) d.follows++; }
    } else if (e.type === "click") {
      row.clicks++; if (d) d.clicks++;
    }
  }

  const list = Object.values(videos).filter((r) => r.answered || r.links || r.clicks);
  const sum = (k) => list.reduce((n, r) => n + r[k], 0);
  const started = sum("started"), converted = sum("converted");
  return {
    days,
    totals: { answered: sum("answered"), links: sum("links"), clicks: sum("clicks"), started, converted,
      followRate: started ? Math.round((converted / started) * 100) : null },
    daily: dayList.map((d) => daily[d]),
    top: list.sort((a, b) => b.clicks - a.clicks || b.links - a.links).slice(0, 10),
  };
}
