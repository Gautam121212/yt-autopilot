import { spawn } from "node:child_process";

/** LOW_POWER caps ffmpeg threads so a laptop stays usable (and cooler) during a local run. */
const LOW_POWER = process.env.LOW_POWER === "true";

export function sh(cmd: string, args: string[]): Promise<string> {
  if (LOW_POWER && cmd === "ffmpeg" && !args.includes("-threads")) args = ["-threads", "2", ...args];
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => { err = (err + d).slice(-8000); });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-2000)}`))));
  });
}

export async function durationSec(file: string): Promise<number> {
  const out = await sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  const d = parseFloat(out);
  if (!Number.isFinite(d) || d <= 0) throw new Error(`bad duration for ${file}: ${out}`);
  return d;
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  if (LOW_POWER) limit = Math.min(limit, 2);
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export const ts = (sec: number) => {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
};
