import { spawn } from "node:child_process";

/** LOW_POWER caps ffmpeg threads so a laptop stays usable (and cooler) during a local run. */
const LOW_POWER = process.env.LOW_POWER === "true";

/** Hard ceiling for any external command. A hung ffmpeg used to stall the whole job for hours. */
const CMD_TIMEOUT_MS = Number(process.env.CMD_TIMEOUT_MS ?? 10 * 60_000);

export function sh(cmd: string, args: string[], timeoutMs = CMD_TIMEOUT_MS): Promise<string> {
  if (LOW_POWER && cmd === "ffmpeg" && !args.includes("-threads")) args = ["-threads", "2", ...args];
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      p.kill("SIGKILL");
    }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => { err = (err + d).slice(-8000); });
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error(`${cmd} was killed after ${Math.round(timeoutMs / 1000)}s (hung): ${args.slice(0, 6).join(" ")} ... ${err.slice(-500)}`));
      code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-2000)}`));
    });
  });
}

/** True when the file is a real, readable media file with a sane duration. */
export async function isPlayable(file: string, minSec = 0.4): Promise<boolean> {
  return durationSec(file).then((d) => d >= minSec, () => false);
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
