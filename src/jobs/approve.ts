import { env, loadChannel } from "../config";
import { closeDb, q, updateVideo } from "../lib/db";
import { closeIssue, comment, listComments } from "../lib/github";
import { log } from "../lib/log";
import { schedulePublic } from "../stages/publish";
import { pickSlot } from "../stages/schedule";

async function main() {
  const issue = Number(env("ISSUE_NUMBER"));
  const label = env("LABEL_NAME");
  const owner = process.env.REPO_OWNER;
  const [v] = await q<{ id: number; youtube_id: string; short_youtube_id: string | null; status: string; sub_niche: string }>("select id, youtube_id, short_youtube_id, status, sub_niche from videos where issue_number = $1", [issue]);
  if (!v || v.status !== "awaiting_approval") return log(`issue #${issue}: nothing awaiting approval`);

  const comments = (await listComments(issue)).filter((c) => !owner || c.user.login === owner);

  if (label === "approve") {
    const override = [...comments].reverse().map((c) => c.body.match(/^\/title\s+(.+)$/m)?.[1]).find(Boolean)?.trim();
    const { slot, publishAt } = await pickSlot(loadChannel(), v.sub_niche);
    let manual = "";
    try {
      await schedulePublic(v.youtube_id, publishAt, override);
      if (v.short_youtube_id) await schedulePublic(v.short_youtube_id, new Date(publishAt.getTime() + 24 * 3600e3));
    } catch (e) {
      // Typical before the API compliance audit passes: uploads are locked private.
      manual = `\n\n⚠️ YouTube refused the schedule (${(e as Error).message.slice(0, 200)}). Publish manually in Studio: long video at ${publishAt.toISOString()}${v.short_youtube_id ? `, short 24h later` : ""}.`;
    }
    await updateVideo(v.id, { publish_slot: slot, publish_at: publishAt, status: "scheduled", ...(override ? { title: override } : {}) });
    await comment(issue, `Scheduled for **${publishAt.toISOString()}** (slot dow=${slot.dow} hour=${slot.hour}).${override ? ` Title set to "${override}".` : ""}${manual}`);
    await closeIssue(issue);
  } else if (label === "reject") {
    const reason = comments.filter((c) => !c.body.startsWith("/title")).pop()?.body ?? "no reason given";
    await updateVideo(v.id, { status: "rejected", rejection_reason: reason.slice(0, 2000) });
    await comment(issue, "Rejected. The reason will be included in the next learning cycle. The private upload remains in Studio; delete it there if you want.");
    await closeIssue(issue);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(closeDb);
