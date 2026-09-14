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
import { createIssue } from "../lib/github";
import { schedulePublic } from "../stages/publish";
import { pickSlot } from "../stages/schedule";

const IST = (d: Date) => d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
const ET = (d: Date) => d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit", hour12: true });

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

  const manual = cfg.publish.manual;
  const plan: string[] = [];

  for (let i = 0; i < longSlots && i < backlog.length; i++) {
    const v = backlog[i]!;
    try {
      const { slot, publishAt } = await pickSlot(cfg, v.sub_niche);
      if (!manual) await schedulePublic(v.youtube_id, publishAt);
      await updateVideo(v.id, { publish_slot: slot, publish_at: publishAt, status: manual ? "awaiting_publish" : "scheduled" });
      usedThisRun.add(v.id);
      plan.push(`**LONG — ${IST(publishAt)} IST** _(${ET(publishAt)} ET)_\n` +
        `${v.title}\nhttps://studio.youtube.com/video/${v.youtube_id}/edit`);
      log(`queue: long #${v.id} "${v.title}" -> ${IST(publishAt)} IST`);
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
      // A day apart, so a Short never shares a slot with a long upload.
      const at = new Date(publishAt.getTime() + 26 * 3600e3);
      if (!manual) await schedulePublic(v.short_youtube_id!, at);
      await updateVideo(v.id, { short_publish_at: at, short_status: manual ? "awaiting_publish" : "scheduled" });
      plan.push(`**SHORT — ${IST(at)} IST** _(${ET(at)} ET)_\n` +
        `${v.title}\nhttps://studio.youtube.com/video/${v.short_youtube_id}/edit`);
      log(`queue: short from #${v.id} ("${v.title}") -> ${IST(at)} IST`);
    } catch (e) {
      await incident("queue.short", e, v.id);
    }
  }

  if (!longSlots && !shortSlots) return log("queue: week is full — backlog stays queued for next week");

  // Anything already planned and due within a day gets its own reminder, so the issue you open
  // in the morning lists exactly what to click today and nothing else.
  const dueNow = await q<{ id: number; title: string; youtube_id: string; short_youtube_id: string | null; publish_at: Date | null; short_publish_at: Date | null; status: string; short_status: string }>(`
    select id, title, youtube_id, short_youtube_id, publish_at, short_publish_at, status, short_status
    from videos
    where (status = 'awaiting_publish' and publish_at between now() and now() + interval '24 hours')
       or (short_status = 'awaiting_publish' and short_publish_at between now() and now() + interval '24 hours')`);
  for (const v of dueNow) {
    const items: string[] = [];
    if (v.status === "awaiting_publish" && v.publish_at) {
      items.push(`**LONG at ${IST(new Date(v.publish_at))} IST** — ${v.title}\nhttps://studio.youtube.com/video/${v.youtube_id}/edit`);
    }
    if (v.short_status === "awaiting_publish" && v.short_publish_at && v.short_youtube_id) {
      items.push(`**SHORT at ${IST(new Date(v.short_publish_at))} IST** — ${v.title}\nhttps://studio.youtube.com/video/${v.short_youtube_id}/edit`);
    }
    if (!items.length) continue;
    await createIssue(`Publish today — ${v.title.slice(0, 60)}`, [
      `Open the link at the time below and set visibility to **Public**.`, ...items,
    ].join("\n\n"), []).catch(async (e) => { await incident("queue.due-issue", e, v.id); return 0; });
    log(`queue: reminder posted for #${v.id}`);
  }

  if (manual && plan.length) {
    const issue = await createIssue(`This week's publishing plan (${plan.length} item${plan.length > 1 ? "s" : ""})`, [
      `Each item is already uploaded and **private**. At the time below, open the link and set visibility to **Public** (or use Studio's own scheduler to set that exact time).`,
      ...plan,
      `_Times are chosen from this channel's own performance data once enough videos exist; until then they rotate across the candidate slots._`,
    ].join("\n\n"), []).catch(async (e) => { await incident("queue.issue", e); return 0; });
    if (issue) log(`queue: publishing plan posted as issue #${issue}`);
  }
}

main().catch(async (e) => { await incident("queue.fatal", e); process.exitCode = 1; }).finally(closeDb);
