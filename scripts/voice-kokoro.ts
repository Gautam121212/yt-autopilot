/** `npm run voice:kokoro` - switch back to the Kokoro neural voice. */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../src/config";

const p = path.join(ROOT, "config/channel.json");
const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
cfg.voice = { provider: "kokoro", voiceId: "af_heart", model: "onnx-community/Kokoro-82M-v1.0-ONNX", speed: 0.95 };
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
console.log('✅ voice.provider = "kokoro".');
export {};
