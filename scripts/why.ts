/** `npm run why` - prints the final check's verdict, scores and issues for the latest video. */
import { closeDb, q } from "../src/lib/db";

const [v] = await q<{ id: number; title: string; status: string; repairs: number; predicted_score: string | null; actual_score: string | null; review: any; verification: any }>(
  "select id, title, status, repairs, predicted_score, actual_score, assets->'review' as review, verification from videos order by id desc limit 1",
);
if (!v) { console.log("No videos yet."); } else {
  const pred = v.predicted_score != null ? Number(v.predicted_score).toFixed(1) : "—";
  const act = v.actual_score != null ? Number(v.actual_score).toFixed(1) : "—";
  console.log(`#${v.id} — ${v.title}\nstatus: ${v.status} · repairs: ${v.repairs ?? 0} · predicted ${pred}/10 vs actual ${act}/10\n`);
  if (v.review) {
    console.log(`FINAL CHECK: ${v.review.decision.toUpperCase()} (${v.review.overall}/10)`);
    console.log(Object.entries(v.review.scores).map(([k, n]) => `  ${k}: ${n}/10`).join("\n"));
    console.log(`\n${v.review.noteForOwner}\n`);
    for (const i of v.review.issues ?? []) console.log(`- [${i.severity}/${i.area ?? "?"}${i.sceneId ? ` @${i.sceneId}` : ""}] ${i.what}\n    fix: ${i.fix}`);
    if (v.review.improvedTitle) console.log(`\nsuggested title: ${v.review.improvedTitle}`);
  } else console.log("No final check recorded.");
  if (v.verification?.issues?.length) {
    console.log(`\nEARLIER STANDARDS REVIEW\n${v.verification.issues.map((i: any) => `- [${i.severity}/${i.category}] ${i.problem}`).join("\n")}`);
  }
}
await closeDb();
