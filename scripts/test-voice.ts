/**
 * `npm run test:voice` - finds exactly which part of text-to-speech hangs or fails.
 * Each stage has its own timeout so nothing can hang forever.
 */
import fs from "node:fs";
import path from "node:path";
import { loadChannel, ROOT } from "../src/config";

const cfg = loadChannel();
console.log(`node ${process.version} ${process.platform} ${process.arch}\nvoice provider: ${cfg.voice.provider}\n`);

async function stage<T>(name: string, ms: number, fn: () => Promise<T>): Promise<T> {
  process.stdout.write(`${name} ... `);
  const t0 = Date.now();
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`TIMED OUT after ${ms / 1000}s`)), ms); });
  try {
    const r = await Promise.race([fn(), timeout]);
    console.log(`✅ ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    return r;
  } catch (e) {
    console.log(`❌ ${(e as Error).message.split("\n")[0]}`);
    throw e;
  } finally {
    clearTimeout(timer!);
  }
}

try {
  const { KokoroTTS } = await stage("1. import kokoro-js", 60_000, () => import("kokoro-js"));
  const { RawAudio, env: hf } = await stage("2. import transformers", 60_000, () => import("@huggingface/transformers"));
  hf.cacheDir = path.join(ROOT, ".model-cache");
  const cached = fs.existsSync(hf.cacheDir);
  console.log(`   model cache: ${cached ? "present" : "empty (first run downloads ~90MB)"}`);

  const tts = await stage("3. load model", 15 * 60_000, () =>
    KokoroTTS.from_pretrained(cfg.voice.model, {
      dtype: "q8",
      device: "cpu",
      progress_callback: (p: { status?: string; file?: string; progress?: number }) => {
        if (p.status === "progress" && p.progress && Math.round(p.progress) % 25 === 0) process.stdout.write(".");
      },
    }));

  const audio = await stage("4. generate one short sentence", 5 * 60_000, () =>
    tts.generate("Venus is the hottest planet.", { voice: cfg.voice.voiceId as "af_heart", speed: cfg.voice.speed }));
  const samples = (audio.audio as Float32Array).length;
  console.log(`   ${(samples / audio.sampling_rate).toFixed(1)}s of audio, ${audio.sampling_rate}Hz`);

  await stage("5. write a wav file", 60_000, async () => {
    fs.mkdirSync(path.join(ROOT, "work"), { recursive: true });
    await new RawAudio(audio.audio as Float32Array, audio.sampling_rate).save(path.join(ROOT, "work/voice-test.wav"));
  });

  console.log("\n✅ Voice works. Run: npm run video:local");
} catch {
  console.log(`\n❌ Voice is broken on this machine at the stage above.`);
  console.log(`   Workaround (macOS only, uses the built-in voice so you can see a full video today):`);
  console.log(`     npm run voice:system   # switches config/channel.json to the system voice`);
  console.log(`     npm run video:local`);
  console.log(`   GitHub Actions runs Linux, where the Kokoro voice is the one that matters — we'll fix that separately.`);
}
process.exit(0);
