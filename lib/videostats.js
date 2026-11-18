// Video performance from Zernio analytics: per video (views, reach, likes, comments, shares, saves,
// engagement, watch time) and the account per day.
import { postAnalytics, dailyMetrics } from "./zernio.js";

const day = (t) => new Date(t).toISOString().slice(0, 10);

export async function videoStats({ days = 30, now = Date.now() } = {}) {
  const posts = [];
  let page = 1, pages = 1, sync = null;
  const from = day(now - 365 * 864e5);
  do {
    const d = await postAnalytics(page, from);
    sync = sync ?? d.overview ?? null;
    for (const p of d.posts ?? []) {
      const ig = (p.platforms ?? []).find((x) => x.platform === "instagram") ?? {};
      const a = p.analytics ?? {};
      posts.push({
        id: ig.platformPostId ?? p._id, caption: String(p.content ?? "").slice(0, 300), thumb: p.thumbnailUrl ?? "",
        permalink: p.platformPostUrl ?? ig.platformPostUrl ?? "", publishedAt: p.publishedAt,
        type: p.mediaProductType === "REELS" ? "REEL" : "POST",
        views: a.views ?? 0, reach: a.reach ?? 0, likes: a.likes ?? 0, comments: a.comments ?? 0, shares: a.shares ?? 0, saves: a.saves ?? 0,
        engagement: a.engagementRate ?? null, avgWatch: a.igReelsAvgWatchTime ? Math.round(a.igReelsAvgWatchTime / 100) / 10 : null,
        skipRate: a.reelsSkipRate ?? null, duration: a.videoDurationSeconds ?? null, updated: a.lastUpdated ?? null,
      });
    }
    pages = d.pagination?.pages ?? 1;
    page++;
  } while (page <= pages && page <= 4);

  let daily = [];
  try {
    const m = await dailyMetrics(day(now - (days - 1) * 864e5), day(now));
    const byDay = new Map((m.dailyData ?? []).map((x) => [String(x.date).slice(0, 10), x.metrics ?? {}]));
    daily = Array.from({ length: days }, (_, i) => {
      const d = day(now - (days - 1 - i) * 864e5), x = byDay.get(d) ?? {};
      return { day: d, views: x.views ?? 0, reach: x.reach ?? 0, likes: x.likes ?? 0, comments: x.comments ?? 0, shares: x.shares ?? 0, saves: x.saves ?? 0 };
    });
  } catch { daily = []; }

  const sum = (k) => posts.reduce((n, p) => n + (p[k] || 0), 0);
  const eng = posts.filter((p) => p.engagement != null);
  return {
    days, lastSync: sync?.lastSync ?? null,
    totals: { posts: posts.length, views: sum("views"), reach: sum("reach"), likes: sum("likes"), comments: sum("comments"), shares: sum("shares"), saves: sum("saves"),
      engagement: eng.length ? Math.round((eng.reduce((n, p) => n + p.engagement, 0) / eng.length) * 100) / 100 : null },
    daily, posts,
  };
}
