/**
 * The feedback loop between rejections and the next attempt.
 *
 * Every gate that rejects a topic or a script records why. Before this, those reasons sat in the
 * incidents table and nothing read them, so the pipeline could reject the same kind of topic for the
 * same reason all day. Now the topic picker and the writer are both told what failed recently.
 *
 * Deliberately recent and short: the last fortnight, a handful per stage. Old lessons go stale as the
 * prompts improve, and a long list of complaints dilutes the brief.
 */
import { q } from "./db";

export type Lesson = { stage: string; title: string | null; reason: string; at: string };

/** Stages whose rejections carry a lesson about TOPICS. Footage judged and found wanting is a topic
 *  problem — its visuals are thin on stock — not a script problem, so scene-qa lives here (#74). */
const TOPIC_STAGES = ["topic.dropped", "topic.unfilmable", "feasibility.abandoned", "scene-qa.abandoned"];
/** Stages whose rejections carry a lesson about SCRIPTS. */
const SCRIPT_STAGES = ["script.too-short", "script.below-bar", "verify.abandoned", "final-check.not-uploaded"];

/**
 * An outage teaches nothing about content. On 22 Sep a Gemini overload was recorded as "13 scenes
 * below 7.5" and fed to the writer as if its script had failed — polluting the loop with noise
 * while real lessons were crowded out. Anything that reads as infrastructure is excluded.
 */
export const INFRA = "(401|403|429|503|quota|overload|busy|unavailable|timeout|timed out|ECONN|fetch failed|user not found|abort)";

async function recent(stages: string[], limit: number): Promise<Lesson[]> {
  return q<Lesson>(
    `select i.stage, v.title, left(i.message, 280) as reason, to_char(i.created_at, 'Mon DD') as at
       from incidents i
       left join videos v on v.id = i.video_id
      where i.stage = any($1) and i.created_at > now() - interval '14 days'
        and i.message !~* '${INFRA}'
      order by i.id desc
      limit $2`,
    [stages, limit],
  ).catch(() => []);
}

export const formatLessons = (xs: Lesson[]) =>
  xs.map((l) => `- ${l.at} · ${l.stage}${l.title ? ` · "${l.title}"` : ""}: ${l.reason.replace(/\s+/g, " ")}`).join("\n");

/** For the topic picker: what kinds of topic have been failing, and why. */
export async function topicLessons(): Promise<string> {
  const xs = await recent(TOPIC_STAGES, 8);
  return xs.length
    ? `RECENTLY REJECTED TOPICS — learn from these; do not pick a topic with the same weakness:\n${formatLessons(xs)}`
    : "";
}

/** For the writer: what has made recent scripts fail, so this one avoids it. */
export async function scriptLessons(): Promise<string> {
  const xs = await recent(SCRIPT_STAGES, 6);
  return xs.length
    ? `RECENT SCRIPTS WERE REJECTED FOR THESE REASONS — avoid every one of them:\n${formatLessons(xs)}`
    : "";
}
