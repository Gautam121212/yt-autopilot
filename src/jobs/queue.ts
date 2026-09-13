/**
 * Publication queue.
 *
 * produce() fills a backlog of finished, privately-uploaded videos. This job decides what actually
 * goes public: up to `maxVideosPerWeek` long videos and `shortsPerWeek` Shorts in any rolling week,
 * and it deliberately takes the Shorts from DIFFERENT videos than that week's long uploads, so the
 * channel never posts a long and its own Short in the same week.
 */
import { loadChannel } from "../config";
import { closeDb, q, updateVideo } from "../lib/db";
import { incident, log } from "../lib/log";
import { schedulePublic } from "../stages/publish";
import { pickSlot } from "../stages/schedule";

type Ready = { id: number; title: string; sub_niche: string; youtube_id: string; short_youtube_id: string | null; short_status: string; actual_score: string | null };

async function main() {
  const cfg = loadChannel();

  // What is already committed for the coming week?
  const [{ n: longsQueued }] = await q<{ n: number }>(
    "select count(*)::int as n from videos where publish_at > now() - interval '7 days' and status in ('scheduled','published')",
  );
  const [{ n: shortsQueued }] = await q<{ n: number }>(
    "select count(*)::int as n from videos where short_publish_at > now() - interval '7 days' and short_status in ('scheduled','published')",
  );
  const longSlots = Math.max(0, cfg.maxVideosPerWeek - longsQueued);
  const shortSlots = Math.max(0, cfg.shortsPerWeek - shortsQueued);
  log(`queue: ${longsQueued}/${cfg.maxVideosPerWeek} longs and ${shortsQueued}/${cfg.shortsPerWeek} shorts committed this week`);

  // Backlog = finished, uploaded private, approved, not yet given a publish time. Best score first.
  const backlog = await q<Ready>(`
    select id, title, sub_niche, youtube_id, short_youtube_id, short_status, actual_score
    from videos
    where status = 'ready' and youtube_id is not null
    order by actual_score desc nulls last, id asc`);
  if (!backlog.length) return log("queue: backlog is empty — produce needs to run");
  log(`queue: ${backlog.length} video(s) in the backlog`);

  const usedThisRun = new Set<number>();

  for (let i = 0; i < longSlots && i < backlog.length; i++) {
    const v = backlog[i]!;
    try {
      const { slot, publishAt } = await pickSlot(cfg, v.sub_niche);
      await schedulePublic(v.youtube_id, publishAt);
      await updateVideo(v.id, { publish_slot: slot, publish_at: publishAt, status: "scheduled" });
      usedThisRun.add(v.id);
      log(`queue: long #${v.id} "${v.title}" -> ${publishAt.toISOString()}`);
    } catch (e) {
      await incident("queue.long", e, v.id);
    }
  }

  // Shorts come from videos whose long is NOT going out this week: different topic, same schedule.
  const shortCandidates = backlog.filter((v) => v.short_youtube_id && v.short_status === "none" && !usedThisRun.has(v.id));
  for (let i = 0; i < shortSlots && i < shortCandidates.length; i++) {
    const v = shortCandidates[i]!;
    try {
      const { publishAt } = await pickSlot(cfg, v.sub_niche);
      // Offset so a Short never lands at the same minute as a long upload.
      const at = new Date(publishAt.getTime() + 26 * 3600e3);
      await schedulePublic(v.short_youtube_id!, at);
      await updateVideo(v.id, { short_publish_at: at, short_status: "scheduled" });
      log(`queue: short from #${v.id} ("${v.title}") -> ${at.toISOString()}`);
    } catch (e) {
      await incident("queue.short", e, v.id);
    }
  }

  if (!longSlots && !shortSlots) log("queue: week is full — backlog stays queued for next week");
}

main().catch(async (e) => { await incident("queue.fatal", e); process.exitCode = 1; }).finally(closeDb);
