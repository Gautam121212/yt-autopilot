import { env, loadChannel } from "../config";
import { closeDb, q, updateVideo } from "../lib/db";
import { closeIssue, comment, listComments } from "../lib/github";
import { log } from "../lib/log";

async function main() {
  const issue = Number(env("ISSUE_NUMBER"));
  const label = env("LABEL_NAME");
  const owner = process.env.REPO_OWNER;
  const [v] = await q<{ id: number; youtube_id: string; short_youtube_id: string | null; status: string; sub_niche: string }>("select id, youtube_id, short_youtube_id, status, sub_niche from videos where issue_number = $1", [issue]);
  if (!v || v.status !== "awaiting_approval") return log(`issue #${issue}: nothing awaiting approval`);

  const comments = (await listComments(issue)).filter((c) => !owner || c.user.login === owner);

  if (label === "approve") {
    const override = [...comments].reverse().map((c) => c.body.match(/^\/title\s+(.+)$/m)?.[1]).find(Boolean)?.trim();
    if (override) {
      const { yt } = await import("../lib/youtube");
      const api = yt();
      const cur = await api.videos.list({ part: ["snippet"], id: [v.youtube_id] });
      const snippet = cur.data.items?.[0]?.snippet;
      if (snippet) await api.videos.update({ part: ["snippet"], requestBody: { id: v.youtube_id, snippet: { ...snippet, title: override.slice(0, 100) } } });
    }
    await updateVideo(v.id, { status: "ready", ...(override ? { title: override } : {}) });
    await comment(issue, `Added to the publish queue${override ? ` with the title "${override}"` : ""}. The queue job gives it a slot within the week's quota (${loadChannel().maxVideosPerWeek} long + ${loadChannel().shortsPerWeek} shorts).`);
    await closeIssue(issue);
  } else if (label === "reject") {
    const reason = comments.filter((c) => !c.body.startsWith("/title")).pop()?.body ?? "no reason given";
    await updateVideo(v.id, { status: "rejected", rejection_reason: reason.slice(0, 2000) });
    await comment(issue, "Rejected. The reason will be included in the next learning cycle. The private upload remains in Studio; delete it there if you want.");
    await closeIssue(issue);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(closeDb);
