import { closeDb, q } from "../lib/db";
import { incident, log } from "../lib/log";
import { ytAnalytics } from "../lib/youtube";

const day = (d: Date) => d.toISOString().slice(0, 10);

async function main() {
  await q("update videos set status = 'published' where status = 'scheduled' and publish_at < now()");
  await q("update videos set short_status = 'published' where short_status = 'scheduled' and short_publish_at < now()");
  const api = ytAnalytics();
  const vids = await q<{ id: number; youtube_id: string; publish_at: Date; has_ret: boolean }>(`
    select v.id, v.youtube_id, v.publish_at, exists(select 1 from retention r where r.video_id = v.id) as has_ret
    from videos v where v.status = 'published' and v.publish_at > now() - interval '90 days'`);

  for (const v of vids) {
    try {
      const res = await api.reports.query({
        ids: "channel==MINE",
        startDate: day(new Date(v.publish_at)),
        endDate: day(new Date()),
        metrics: "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,subscribersGained",
        dimensions: "day",
        filters: `video==${v.youtube_id}`,
      });
      for (const r of res.data.rows ?? []) {
        await q(`insert into metrics_daily (video_id, day, views, watch_minutes, avg_view_sec, avg_view_pct, likes, comments, subs_gained)
                 values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                 on conflict (video_id, day) do update set views=excluded.views, watch_minutes=excluded.watch_minutes,
                   avg_view_sec=excluded.avg_view_sec, avg_view_pct=excluded.avg_view_pct, likes=excluded.likes,
                   comments=excluded.comments, subs_gained=excluded.subs_gained`, [v.id, ...r]);
      }

      const ageDays = (Date.now() - new Date(v.publish_at).getTime()) / 86400e3;
      if (!v.has_ret && ageDays >= 7) {
        const ret = await api.reports.query({
          ids: "channel==MINE",
          startDate: day(new Date(v.publish_at)),
          endDate: day(new Date()),
          metrics: "audienceWatchRatio,relativeRetentionPerformance",
          dimensions: "elapsedVideoTimeRatio",
          filters: `video==${v.youtube_id}`,
        });
        for (const r of ret.data.rows ?? []) {
          await q("insert into retention (video_id, elapsed_ratio, watch_ratio, relative_perf) values ($1,$2,$3,$4) on conflict do nothing", [v.id, ...r]);
        }
      }
      log(`#${v.id} analytics updated`);
    } catch (e) {
      await incident("analytics", e, v.id);
    }
  }
}

main().catch(async (e) => { await incident("analytics.fatal", e); process.exitCode = 1; }).finally(closeDb);
