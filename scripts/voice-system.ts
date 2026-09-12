/** `npm run voice:system` - switch config/channel.json to the operating system's built-in voice. */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../src/config";

const p = path.join(ROOT, "config/channel.json");
const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
cfg.voice = { provider: "system", voiceId: process.platform === "darwin" ? "Samantha" : "en-us", model: "system", speed: 1 };
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
console.log(`✅ voice.provider = "system" (${cfg.voice.voiceId}). Revert with: npm run voice:kokoro`);
export {};
