import type { ChannelConfig, Slot } from "../config";
import { q } from "../lib/db";

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Next instant (UTC) that is `dow` at `hour`:00 in the audience timezone, at or after `after`. */
export function nextOccurrence(slot: Slot, tz: string, after: Date): Date {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" });
  const step = 15 * 60 * 1000;
  let t = Math.ceil(after.getTime() / step) * step;
  for (let i = 0; i < 4 * 24 * 36; i++, t += step) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    if (DOW[p.weekday!] === slot.dow && Number(p.hour) === slot.hour && Number(p.minute) === 0) return new Date(t);
  }
  throw new Error("no occurrence found");
}

const key = (s: Slot) => `${s.dow}-${s.hour}`;

/**
 * Epsilon-greedy over candidate slots, scored by first-48h views.
 * Honest caveat: topic dominates early views, so this only converges after many samples per slot.
 */
export async function pickSlot(cfg: ChannelConfig, subNiche?: string): Promise<{ slot: Slot; publishAt: Date }> {
  const rows = await q<{ publish_slot: Slot; sub_niche: string; views: string }>(`
    select v.publish_slot, v.sub_niche, coalesce(sum(m.views), 0) as views
    from videos v join metrics_daily m on m.video_id = v.id
      and m.day <= (v.publish_at at time zone 'UTC')::date + 1
    where v.status = 'published' and v.publish_at < now() - interval '3 days' and v.publish_slot is not null
    group by v.id, v.publish_slot, v.sub_niche`);

  // Prefer this sub-niche's own history (different topics peak at different hours), but only once
  // there is enough of it to mean anything; otherwise fall back to the whole channel.
  const own = subNiche ? rows.filter((r) => r.sub_niche === subNiche) : [];
  const source = own.length >= cfg.publish.minSamplesPerSlot * 2 ? own : rows;
  const stats = new Map<string, number[]>();
  for (const r of source) stats.set(key(r.publish_slot), [...(stats.get(key(r.publish_slot)) ?? []), Number(r.views)]);
  const slots = cfg.publish.candidateSlots;
  const n = (s: Slot) => stats.get(key(s))?.length ?? 0;
  const mean = (s: Slot) => { const v = stats.get(key(s)) ?? []; return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };

  let slot: Slot;
  const underSampled = slots.filter((s) => n(s) < cfg.publish.minSamplesPerSlot);
  if (underSampled.length) slot = underSampled.sort((a, b) => n(a) - n(b))[0]!;
  else if (Math.random() < cfg.publish.epsilon) slot = slots[Math.floor(Math.random() * slots.length)]!;
  else slot = [...slots].sort((a, b) => mean(b) - mean(a))[0]!;

  const taken = (await q<{ publish_at: Date }>(
    "select publish_at from videos where status in ('scheduled','published') and publish_at > now() - interval '7 days'",
  )).map((r) => new Date(r.publish_at).getTime());

  let after = new Date(Date.now() + cfg.publish.minHoursAhead * 3600e3);
  for (let i = 0; i < 8; i++) {
    const at = nextOccurrence(slot, cfg.audienceTimezone, after);
    if (taken.every((t) => Math.abs(t - at.getTime()) >= cfg.publish.minGapHours * 3600e3)) return { slot, publishAt: at };
    after = new Date(at.getTime() + 3600e3);
  }
  throw new Error("could not find a free publish slot in the next 8 weeks");
}
