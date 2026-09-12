import { q } from "./db";

export const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

/** Records a problem so the weekly learning job can see recurring failures. Never throws. */
export async function incident(stage: string, err: unknown, videoId?: number) {
  const message = err instanceof Error ? err.message : String(err);
  const detail = err instanceof Error ? (err.stack ?? "") : "";
  console.error(`[incident] ${stage}: ${message}`);
  try {
    await q("insert into incidents (video_id, stage, message, detail) values ($1, $2, $3, $4)", [
      videoId ?? null, stage, message.slice(0, 2000), detail.slice(0, 8000),
    ]);
  } catch (e) {
    console.error("could not record incident", e);
  }
}
