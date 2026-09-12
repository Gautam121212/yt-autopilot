/** `npm run retry` - send the latest video back through media + final check (keeps script and research). */
import { closeDb, q } from "../src/lib/db";
const [v] = await q<{ id: number; title: string }>("select id, title from videos order by id desc limit 1");
if (!v) console.log("No videos yet.");
else {
  await q("update videos set status='verified', attempts=0, repairs=0, youtube_id=null, short_youtube_id=null where id=$1", [v.id]);
  console.log(`#${v.id} "${v.title}" reset to 'verified'. Run: npm run video:local`);
}
await closeDb();
