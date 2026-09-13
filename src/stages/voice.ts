import fs from "node:fs/promises";
import path from "node:path";
import { env, ROOT, type ChannelConfig } from "../config";
import { fetchOk, withRetry } from "../lib/http";
import { durationSec, mapLimit, sh } from "../lib/media";

type Narrated = { id: string; narration: string };

/** segments = exact per-sentence timing (seconds from scene start), used for accurate captions */
export type SceneAudio = { sceneId: string; file: string; duration: number; segments?: { text: string; start: number; end: number }[] };

// Kokoro: free, Apache-2.0, runs on CPU. Model (~90MB) is cached between runs.
let kokoro: import("kokoro-js").KokoroTTS | undefined;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s — run \`npm run test:voice\` to see which stage hangs`)), ms); }),
  ]).finally(() => clearTimeout(timer!)) as Promise<T>;
}

/** Split into sentences so each generate() call stays inside the model's context window. */
const sentences = (text: string) =>
  text.match(/[^.!?]+[.!?]*\s*/g)?.map((x) => x.trim()).filter(Boolean) ?? [text];

async function kokoroTts(cfg: ChannelConfig, text: string, file: string): Promise<{ text: string; start: number; end: number }[]> {
  const { KokoroTTS } = await import("kokoro-js");
  const { RawAudio, env: hf } = await import("@huggingface/transformers");
  hf.cacheDir = path.join(ROOT, ".model-cache"); // cached by GitHub Actions between runs
  kokoro ??= await withTimeout(
    KokoroTTS.from_pretrained(cfg.voice.model, { dtype: "q8", device: "cpu" }),
    15 * 60_000, "loading the voice model",
  );

  // generate() per sentence: simpler and more reliable in Node than the streaming generator.
  const parts: Float32Array[] = [];
  const segments: { text: string; start: number; end: number }[] = [];
  let rate = 24000;
  let t = 0;
  for (const sentence of sentences(text)) {
    const audio = await withTimeout(
      kokoro.generate(sentence, { voice: cfg.voice.voiceId as "af_heart", speed: cfg.voice.speed }),
      3 * 60_000, `speaking "${sentence.slice(0, 40)}..."`,
    );
    rate = audio.sampling_rate;
    const samples = audio.audio as Float32Array;
    const len = samples.length / rate;
    segments.push({ text: sentence, start: t, end: t + len });
    const gap = Math.round(rate * 0.12);
    parts.push(samples, new Float32Array(gap));
    t += len + gap / rate;
  }
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  await new RawAudio(out, rate).save(file);
  return segments;
}

/** The operating system's built-in voice: macOS `say`, Linux `espeak-ng`. Free, instant, lower quality. */
async function systemTts(cfg: ChannelConfig, text: string, file: string) {
  const raw = `${file}.raw.wav`;
  if (process.platform === "darwin") {
    await sh("say", ["-v", cfg.voice.voiceId, "-r", String(Math.round(175 * cfg.voice.speed)), "-o", raw, "--data-format=LEF32@22050", text]);
  } else {
    await sh("espeak-ng", ["-v", cfg.voice.voiceId, "-s", String(Math.round(165 * cfg.voice.speed)), "-w", raw, text]);
  }
  await sh("ffmpeg", ["-y", "-i", raw, "-ar", "24000", "-ac", "1", file]);
  await fs.rm(raw, { force: true });
}

async function elevenlabs(cfg: ChannelConfig, text: string, prev?: string, next?: string): Promise<Buffer> {
  const res = await fetchOk(
    `https://api.elevenlabs.io/v1/text-to-speech/${cfg.voice.voiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": env("ELEVENLABS_API_KEY"), "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: cfg.voice.model,
        previous_text: prev, // keeps intonation continuous across scene boundaries
        next_text: next,
        voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.2 },
      }),
    },
  );
  return Buffer.from(await res.arrayBuffer());
}

async function openaiTts(cfg: ChannelConfig, text: string): Promise<Buffer> {
  const res = await fetchOk("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${env("OPENAI_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: cfg.voice.model, voice: cfg.voice.voiceId, input: text, response_format: "mp3" }),
  });
  return Buffer.from(await res.arrayBuffer());
}

export async function synthesize(cfg: ChannelConfig, scenes: Narrated[], dir: string): Promise<SceneAudio[]> {
  await fs.mkdir(dir, { recursive: true });
  if (cfg.voice.provider === "kokoro" || cfg.voice.provider === "system") {
    console.log(`  voice: preparing ${cfg.voice.provider} for ${scenes.length} scenes`);
    const out: SceneAudio[] = [];
    for (const [i, s] of scenes.entries()) { // CPU-bound: sequential
      const file = path.join(dir, `${String(i).padStart(3, "0")}.wav`);
      let segments: { text: string; start: number; end: number }[] | undefined;
      if (cfg.voice.provider === "kokoro") segments = await kokoroTts(cfg, s.narration, file);
      else await systemTts(cfg, s.narration, file);
      const duration = await durationSec(file);
      if (duration < 0.3) throw new Error(`voice produced an empty clip for scene ${s.id}`);
      out.push({ sceneId: s.id, file, duration, segments });
      if (i === 0 || (i + 1) % 5 === 0 || i === scenes.length - 1) {
        console.log(`  voice ${i + 1}/${scenes.length}`);
      }
    }
    return out;
  }
  return mapLimit(scenes, 3, async (s, i) => {
    const file = path.join(dir, `${String(i).padStart(3, "0")}.mp3`);
    const buf = await withRetry(
      () => cfg.voice.provider === "elevenlabs"
        ? elevenlabs(cfg, s.narration, scenes[i - 1]?.narration, scenes[i + 1]?.narration)
        : openaiTts(cfg, s.narration),
      `tts ${s.id}`,
    );
    await fs.writeFile(file, buf);
    return { sceneId: s.id, file, duration: await durationSec(file) };
  });
}
