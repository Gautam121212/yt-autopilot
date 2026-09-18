/**
 * One interface, three providers:
 *  - claude-code (default): your Claude Pro/Max subscription via the official Claude Code CLI
 *    in headless mode, authenticated with CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`.
 *  - anthropic: pay-as-you-go API key (ANTHROPIC_API_KEY).
 *  - gemini: free Google AI Studio key (GEMINI_API_KEY), Flash models only.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { env, ROOT } from "../config";
import { fetchOk, withRetry } from "./http";

/** Model calls are slow by nature — a script can take minutes. Only image/metadata calls use the short deadline. */
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 6 * 60_000);

export type Tier = "heavy" | "light";
const PROVIDER = process.env.LLM_PROVIDER || "gemini";

export const usage = { inputTokens: 0, outputTokens: 0, calls: 0, webSearches: 0, estCostUsd: 0 };

const MODELS: Record<string, Record<Tier, string>> = {
  "claude-code": { heavy: process.env.CLAUDE_MODEL_HEAVY || "opus", light: process.env.CLAUDE_MODEL_LIGHT || "sonnet" },
  anthropic: { heavy: process.env.CLAUDE_MODEL_HEAVY || "claude-opus-5", light: process.env.CLAUDE_MODEL_LIGHT || "claude-sonnet-5" },
  // No hard-coded fallback: Google closes older models to new keys, so `npm run models` probes
  // and writes a model that actually answers. An empty value is a setup error, not a default.
  gemini: { heavy: process.env.GEMINI_MODEL_HEAVY || "", light: process.env.GEMINI_MODEL_LIGHT || "" },
  "openai-compatible": { heavy: process.env.OPENAI_COMPAT_MODEL_HEAVY || "", light: process.env.OPENAI_COMPAT_MODEL_LIGHT || "" },
};

export type CallOpts = {
  /** allow live web search/fetch, where the provider supports it */
  web?: boolean;
  /** directory of files the model may read (claude-code) */
  readDir?: string;
  /** image files to show the model (all providers that support vision) */
  images?: string[];
};

/** claude-code can search the live web; the Gemini free path cannot (grounding + JSON output conflict). */
export class QuotaError extends Error {}
export const isQuota = (e: unknown) =>
  e instanceof QuotaError ||
  /\b429\b|\b402\b|exceeded your current quota|rate[- ]?limit|out of daily quota|requires more credits|insufficient|RESOURCE_EXHAUSTED/i
    .test((e as Error)?.message ?? "");

export const providerSupportsWeb = () => PROVIDER === "claude-code";
/** every supported provider can look at images, by different means. */
export const providerSupportsVision = () => PROVIDER === "claude-code" || PROVIDER === "gemini" || process.env.OPENAI_COMPAT_VISION === "true";

// ---------------- claude-code (subscription) ----------------
let heavyFallback = false; // flips if the plan has no access to the heavy model

function runClaude(model: string, system: string, prompt: string, schema: object, o: CallOpts): Promise<{ structured: unknown; text: string }> {
  const tools = [o.web ? "WebSearch,WebFetch" : "", o.readDir ? "Read" : ""].filter(Boolean).join(",");
  const args = [
    "-p", "--output-format", "json", "--model", model, "--system-prompt", system,
    "--permission-mode", "dontAsk", "--no-session-persistence",
    "--tools", tools, "--json-schema", JSON.stringify(schema),
    ...(tools ? ["--allowedTools", tools] : []),
  ];
  // Isolated config dir: your personal ~/.claude settings/memory never leak into the pipeline.
  const configDir = path.join(ROOT, ".claude-runtime");
  fs.mkdirSync(configDir, { recursive: true });
  const cwd = o.readDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "cc-"));
  return new Promise((resolve, reject) => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: configDir, DISABLE_AUTOUPDATER: "1" };
    delete childEnv.ANTHROPIC_API_KEY; // an API key would silently take precedence over the subscription token
    delete childEnv.ANTHROPIC_AUTH_TOKEN;
    const p = spawn("claude", args, { cwd, env: childEnv });
    let out = "";
    let err = "";
    const timer = setTimeout(() => p.kill("SIGINT"), 25 * 60 * 1000);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    p.on("error", (e) => reject(new Error(`could not start Claude Code CLI (is it installed? run: curl -fsSL https://claude.ai/install.sh | bash): ${e.message}`)));
    p.on("close", () => {
      clearTimeout(timer);
      const line = out.trim().split("\n").filter(Boolean).pop() ?? "";
      let j: {
        is_error?: boolean; result?: string; structured_output?: unknown; api_error_status?: number; total_cost_usd?: number;
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; server_tool_use?: { web_search_requests?: number } };
      };
      try { j = JSON.parse(line); } catch { return reject(new Error(`Claude Code returned non-JSON: ${line.slice(0, 300)} ${err}`)); }
      usage.calls++;
      usage.inputTokens += (j.usage?.input_tokens ?? 0) + (j.usage?.cache_read_input_tokens ?? 0);
      usage.outputTokens += j.usage?.output_tokens ?? 0;
      usage.webSearches += j.usage?.server_tool_use?.web_search_requests ?? 0;
      usage.estCostUsd += j.total_cost_usd ?? 0;
      if (j.is_error) {
        const e = new Error(`Claude Code error${j.api_error_status ? ` ${j.api_error_status}` : ""}: ${j.result ?? err}`) as Error & { status?: number };
        e.status = j.api_error_status;
        return reject(e);
      }
      resolve({ structured: j.structured_output, text: j.result ?? "" });
    });
    p.stdin.end(prompt);
  });
}

async function claudeCode(tier: Tier, system: string, prompt: string, schema: object, o: CallOpts): Promise<unknown> {
  const model = tier === "heavy" && heavyFallback ? MODELS["claude-code"].light : MODELS["claude-code"][tier];
  try {
    const r = await withRetry(() => runClaude(model, system, prompt, schema, o), `claude ${model}`, 4);
    return r.structured ?? extractJson(r.text);
  } catch (e) {
    const msg = (e as Error).message;
    if (tier === "heavy" && !heavyFallback && /model|not available|not_found|404|403/i.test(msg) && !/401/.test(msg)) {
      console.warn(`heavy model "${model}" unavailable on this plan; falling back to ${MODELS["claude-code"].light}`);
      heavyFallback = true;
      return claudeCode(tier, system, prompt, schema, o);
    }
    if (/401|authenticat/i.test(msg)) throw new Error(`${msg}\nFIX: run \`claude setup-token\` again and update CLAUDE_CODE_OAUTH_TOKEN (npm run setup, then npm run github).`);
    if (/429|rate|usage limit/i.test(msg)) throw new Error(`${msg}\nYour Claude plan's usage limit is reached; the next scheduled run will retry.`);
    throw e;
  }
}

// ---------------- anthropic (API key) ----------------
async function anthropic(model: string, system: string, prompt: string, maxTokens: number): Promise<string> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ maxRetries: 4 });
  const res = await client.messages.create({ model, system, max_tokens: Math.min(maxTokens, 16000), messages: [{ role: "user", content: prompt }] });
  usage.calls++;
  usage.inputTokens += res.usage.input_tokens;
  usage.outputTokens += res.usage.output_tokens;
  if (res.stop_reason === "max_tokens") throw new Error("Claude hit max_tokens");
  return res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

// ---------------- openai-compatible (Groq, OpenRouter, Cerebras, Mistral, DeepSeek, ...) ----------------
async function openaiCompatible(model: string, system: string, prompt: string, maxTokens: number, images?: string[]): Promise<string> {
  const base = (process.env.OPENAI_COMPAT_BASE_URL || "").replace(/\/$/, "");
  // Some free tiers cap output tokens per minute (Groq's is 1000), and reject the request outright
  // if max_tokens is larger than that — so keep the ask small and configurable.
  const cap = Number(process.env.OPENAI_COMPAT_MAX_TOKENS ?? 4096);
  maxTokens = Math.min(maxTokens, cap);
  if (!base) throw new Error("Set OPENAI_COMPAT_BASE_URL (e.g. https://api.groq.com/openai/v1)");
  const content: unknown[] = [];
  for (const f of images ?? []) {
    content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${(await fs.promises.readFile(f)).toString("base64")}` } });
  }
  content.push({ type: "text", text: prompt });
  const res = await withRetry(() => fetchOk(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env("OPENAI_COMPAT_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: images?.length ? content : prompt }],
      max_tokens: maxTokens,
      temperature: 0.8,
      response_format: { type: "json_object" },
    }),
  }, LLM_TIMEOUT_MS), `openai-compat ${model}`, 3).catch((e: Error) => {
    if (/requires more credits|insufficient credits|\b402\b/i.test(e.message)) {
      throw new QuotaError(`${model} has no credit left on this account.\n` +
        `Run \`npm run models:backup\` to switch to a free (":free") model, or top up the provider.\n${e.message.slice(0, 200)}`);
    }
    if (/Request too large|enforced limit|tokens per minute|OTPM/i.test(e.message)) {
      throw new QuotaError(`${model} rejected the request: this provider's free tier caps output tokens per minute, ` +
        `which is too small for a full script.\nEither lower OPENAI_COMPAT_MAX_TOKENS for light tasks only, ` +
        `or use a provider with per-day rather than per-minute output limits (see SETUP.md "Backup provider").\n${e.message.slice(0, 200)}`);
    }
    throw e;
  });
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  usage.calls++;
  usage.inputTokens += j.usage?.prompt_tokens ?? 0;
  usage.outputTokens += j.usage?.completion_tokens ?? 0;
  const text = j.choices?.[0]?.message?.content;
  if (!text) throw new Error(`${model} returned no content: ${JSON.stringify(j).slice(0, 300)}`);
  return text;
}

// ---------------- gemini (free key) ----------------
let lastGemini = 0;
async function geminiParts(images: string[] = []) {
  const parts: Record<string, unknown>[] = [];
  for (const f of images) {
    parts.push({ inline_data: { mime_type: f.endsWith(".png") ? "image/png" : "image/jpeg", data: (await fs.promises.readFile(f)).toString("base64") } });
  }
  return parts;
}

async function gemini(model: string, system: string, prompt: string, maxTokens: number, images?: string[]): Promise<string> {
  const wait = lastGemini + 7000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGemini = Date.now();
  const imageParts = await geminiParts(images); // read files once, outside the retry loop
  const res = await withRetry(() => fetchOk(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": env("GEMINI_API_KEY"), "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [...imageParts, { text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: maxTokens, temperature: 0.8 },
    }),
  }, LLM_TIMEOUT_MS), `gemini ${model}`, 5).catch((e: Error) => {
    // Listing a model does not mean you may call it; Google closes older ones to new keys.
    if (/\b404\b/.test(e.message)) throw new Error(`Gemini model "${model}" is not callable by this key. Run \`npm run models\` to pick one that is.\n${e.message.slice(0, 200)}`);
    throw e;
  });
  const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]; promptFeedback?: unknown; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
  usage.calls++;
  usage.inputTokens += j.usageMetadata?.promptTokenCount ?? 0;
  usage.outputTokens += j.usageMetadata?.candidatesTokenCount ?? 0;
  const c = j.candidates?.[0];
  if (!c) throw new Error(`Gemini returned no candidate: ${JSON.stringify(j.promptFeedback ?? j).slice(0, 400)}`);
  if (c.finishReason === "MAX_TOKENS") throw new Error("Gemini hit max tokens");
  return (c.content?.parts ?? []).map((p) => p.text ?? "").join("");
}

const geminiDown = new Set<string>(); // models that returned 503/429 during this run

/** GEMINI_MODEL_* may list several models, newest first: "gemini-3.8-flash,gemini-3.6-flash". */
async function geminiWithFallback(spec: string, system: string, prompt: string, maxTokens: number, images?: string[]): Promise<string> {
  const chain = spec.split(",").map((m) => m.trim()).filter(Boolean);
  const order = [...chain.filter((m) => !geminiDown.has(m)), ...chain.filter((m) => geminiDown.has(m))];
  let last: Error | undefined;
  for (const model of order) {
    try {
      const out = await gemini(model, system, prompt, maxTokens, images);
      geminiDown.delete(model);
      return out;
    } catch (e) {
      last = e as Error;
      if (!/(\b503\b|\b429\b|UNAVAILABLE|overload|high demand|rate)/i.test(last.message)) throw last;
      geminiDown.add(model);
      console.warn(`${model} is busy; trying the next model listed in GEMINI_MODEL_* ...`);
    }
  }
  throw new QuotaError(`Every model in "${spec}" is rate-limited or out of daily quota.\nThe Gemini free tier resets at midnight Pacific. Add a backup provider to keep going (see SETUP.md "Backup provider").\n${last?.message.slice(0, 300)}`);
}

export function extractJson(text: string): unknown {
  const tagged = [...text.matchAll(/<json>([\s\S]*?)<\/json>/g)].pop()?.[1];
  const body = tagged ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(body.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
}

/** Calls the LLM and validates JSON output with zod; feeds validation errors back, 3 attempts. */
export async function askJson<T>(o: {
  tier: Tier;
  system: string;
  prompt: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  maxTokens?: number;
} & CallOpts): Promise<T> {
  const jsonSchema = zodToJsonSchema(o.schema, { $refStrategy: "none", target: "jsonSchema7" }) as Record<string, unknown>;
  delete jsonSchema.$schema;
  let feedback = "";
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`    [llm] ${o.tier} call${attempt > 1 ? ` (attempt ${attempt})` : ""}${o.web ? " +web" : ""}${o.images?.length ? " +images" : ""}`);
    let raw: unknown;
    if (PROVIDER === "claude-code") {
      const readDir = o.readDir ?? (o.images?.length ? path.dirname(o.images[0]!) : undefined);
      raw = await claudeCode(o.tier, o.system, o.prompt + feedback, jsonSchema, { ...o, readDir });
    } else {
      const model = MODELS[PROVIDER]?.[o.tier];
      if (!model) throw new Error(PROVIDER === "gemini" ? "GEMINI_MODEL_HEAVY/GEMINI_MODEL_LIGHT are not set. Run `npm run models`."
        : PROVIDER === "openai-compatible" ? "OPENAI_COMPAT_MODEL_HEAVY/LIGHT are not set in .env."
        : `Unknown LLM_PROVIDER ${PROVIDER}`);
      const body = `${o.prompt}\n\nReturn ONE JSON object only matching this JSON Schema:\n${JSON.stringify(jsonSchema)}${feedback}`;
      const backupReady = !!(process.env.OPENAI_COMPAT_BASE_URL && process.env.OPENAI_COMPAT_API_KEY && process.env.OPENAI_COMPAT_MODEL_HEAVY);
      const text = PROVIDER === "anthropic" ? await anthropic(model, o.system, body, o.maxTokens ?? 32000)
        : PROVIDER === "openai-compatible" ? await openaiCompatible(model, o.system, body, o.maxTokens ?? 16000, o.images)
        : await geminiWithFallback(model, o.system, body, o.maxTokens ?? 24000, o.images).catch(async (e) => {
            if (!isQuota(e) || !backupReady) throw e;
            const cap = Number(process.env.OPENAI_COMPAT_MAX_TOKENS ?? 4096);
            if ((o.maxTokens ?? 16000) > cap && cap < 4096) {
              throw new QuotaError(`${(e as Error).message}\n\nThe backup provider's output cap (OPENAI_COMPAT_MAX_TOKENS=${cap}) is too small for this step.`);
            }
            const backup = (o.tier === "heavy" ? process.env.OPENAI_COMPAT_MODEL_HEAVY : process.env.OPENAI_COMPAT_MODEL_LIGHT) || process.env.OPENAI_COMPAT_MODEL_HEAVY!;
            // Most backup models are text-only; sending images gets a hard 404 from the router.
            const backupSeesImages = process.env.OPENAI_COMPAT_VISION === "true";
            if (o.images?.length && !backupSeesImages) {
              console.warn(`Gemini is out of quota; ${backup} cannot see images, so judging on text only`);
            }
            return openaiCompatible(backup, o.system, body, o.maxTokens ?? 16000, backupSeesImages ? o.images : undefined);
          });
      try { raw = extractJson(text); } catch (e) { raw = undefined; lastErr = (e as Error).message; }
    }
    const parsed = o.schema.safeParse(raw);
    if (parsed.success) return parsed.data;
    lastErr = parsed.error.message.slice(0, 1500);
    feedback = `\n\nYour previous answer was rejected by the validator:\n${lastErr}\nFix every listed problem.`;
  }
  // Summarise rather than dumping raw zod output: the point is to see WHICH field failed.
  const fields = [...new Set([...lastErr.matchAll(/"path":\s*\[([^\]]*)\]/g)]
    .map((m) => m[1]!.replace(/["',]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean))].slice(0, 8);
  throw new Error(
    `the model's answer did not match the required shape after 3 attempts.` +
    (fields.length ? `\nfields at fault: ${fields.join(" · ")}` : "") +
    `\n${lastErr.slice(0, 600)}`,
  );
}
