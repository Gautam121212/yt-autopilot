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

/**
 * Per-tier deadlines. A single global value killed the research call at 120s — it reads tens of
 * thousands of characters and writes a full dossier, so it needs minutes, while a scene-relevance
 * check should fail fast.
 */
const LLM_TIMEOUT_LIGHT = Number(process.env.LLM_TIMEOUT_LIGHT_MS ?? 150_000);
const LLM_TIMEOUT_HEAVY = Number(process.env.LLM_TIMEOUT_HEAVY_MS ?? 7 * 60_000);
const timeoutFor = (tier: "light" | "heavy") => (tier === "heavy" ? LLM_TIMEOUT_HEAVY : LLM_TIMEOUT_LIGHT);

export type Tier = "heavy" | "light";

/**
 * Which model does which job.
 *
 * Splitting the work is what makes a free-tier pipeline survive: Gemini's daily quota is small but
 * it is the only provider here that can SEE (vision), so it is spent on judging and repairing.
 * Mistral's free tier is roughly a billion tokens a month, so it does the bulk writing.
 *
 * "auto" = use LLM_PROVIDER, i.e. the old single-provider behaviour.
 */
export type Role = "gate" | "write" | "judge" | "vision" | "auto";
const PROVIDER = process.env.LLM_PROVIDER || "gemini";

export const usage = { inputTokens: 0, outputTokens: 0, calls: 0, webSearches: 0, estCostUsd: 0 };

/** name -> OpenAI-compatible endpoint for stage routing. Gemini is handled separately. */
const NAMED: Record<string, { baseUrl: string; key: string; heavy: string; light: string }> = {
  mistral: {
    baseUrl: process.env.MISTRAL_BASE_URL || "https://api.mistral.ai/v1",
    key: process.env.MISTRAL_API_KEY || "",
    // Dated ids, not "-latest" aliases: an alias can point at a model the key is not entitled to,
    // which is what produced 403s. Defaults chosen from the account's own limits page —
    // mistral-large-2512 at 250k tokens/min for writing, ministral-8b at 625k/min and 3.13 rps
    // for the many small gate calls.
    // The ministral family is what free keys are actually served: 937k/625k/1.3M tokens per minute
    // against 20k for the mistral-medium family, which returns 1300 (rate limited) on a free plan.
    // 937k tokens/min for the long script answer; 1.3M/min at 12.5 req/s for the many small calls.
    heavy: process.env.MISTRAL_MODEL_HEAVY || "ministral-14b-2512",
    light: process.env.MISTRAL_MODEL_LIGHT || "ministral-3b-2512",
  },
  groq: {
    // gpt-oss-120b fails JSON-mode validation and llama-3.1-8b-instant no longer exists.
    // qwen3-32b honours response_format properly.
    baseUrl: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
    key: process.env.GROQ_API_KEY || "",
    heavy: process.env.GROQ_MODEL_HEAVY || "qwen/qwen3-32b",
    light: process.env.GROQ_MODEL_LIGHT || "qwen/qwen3-32b",
  },
  cerebras: {
    // NOTE: returns 402 "payment required" on new accounts — the $5 credit needs a card attached.
    // Kept configurable in case that changes; do not rely on it.
    baseUrl: process.env.CEREBRAS_BASE_URL || "https://api.cerebras.ai/v1",
    key: process.env.CEREBRAS_API_KEY || "",
    heavy: process.env.CEREBRAS_MODEL_HEAVY || "gpt-oss-120b",
    light: process.env.CEREBRAS_MODEL_LIGHT || "gpt-oss-120b",
  },
  zai: {
    // GLM-4.7-Flash: 200K context, 128K output, but ONE concurrent request and frequently
    // congested (error 1305 "model too busy"). Good when it answers; never rely on it alone.
    baseUrl: process.env.ZAI_BASE_URL || "https://open.bigmodel.cn/api/paas/v4",
    key: process.env.ZAI_API_KEY || "",
    heavy: process.env.ZAI_MODEL_HEAVY || "glm-4.7-flash",
    light: process.env.ZAI_MODEL_LIGHT || "glm-4.5-flash",
  },
  nvidia: {
    // NOTE: the llama-3.x endpoints now return 410 Gone. Set NVIDIA_MODEL_* to a model that is
    // still live at build.nvidia.com before enabling this.
    baseUrl: process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1",
    key: process.env.NVIDIA_API_KEY || "",
    heavy: process.env.NVIDIA_MODEL_HEAVY || "meta/llama-3.3-70b-instruct",
    light: process.env.NVIDIA_MODEL_LIGHT || "meta/llama-3.1-8b-instruct",
  },
  openrouter: {
    baseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
    key: process.env.OPENROUTER_API_KEY || "",
    // NOTE: the well-known ":free" slugs now answer "unavailable for free". Check
    // openrouter.ai/models?q=free for a current one before enabling this.
    heavy: process.env.OPENROUTER_MODEL_HEAVY || "z-ai/glm-4.5-air:free",
    light: process.env.OPENROUTER_MODEL_LIGHT || "z-ai/glm-4.5-air:free",
  },
};

/**
 * Which provider handles each job, chosen by what each is actually good at rather than by
 * preference. Measured with `npm run providers`:
 *
 *   gate   — dozens of small JSON calls. Wants requests-per-second, not intelligence.
 *            ministral-3b: 1.3M tokens/min at 12.5 req/s.
 *   write  — one long JSON answer against a big dossier. Wants output budget and context.
 *            ministral-14b: 937k tokens/min. Gemini's 8192-token output cap is the binding
 *            constraint there, which is why writing should NOT be Gemini's job.
 *   judge  — reading a script and scoring it. Text only, so it need not cost Gemini quota.
 *   vision — image QA and the final check. These look at pixels, and Gemini is the only free
 *            provider here that can. Everything else is kept off it so this always has quota.
 */
const ROLE_PROVIDER: Record<Exclude<Role, "auto">, string> = {
  gate: process.env.LLM_ROLE_GATE || "",      // topic scoring, feasibility, per-scene checks
  write: process.env.LLM_ROLE_WRITE || "",    // research, script, expand, comedy
  judge: process.env.LLM_ROLE_JUDGE || "",    // verify, forecast, repairs — text only
  vision: process.env.LLM_ROLE_VISION || "",  // image QA, final review — needs to SEE
};

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

/** A key that was refused (401/403) will be refused again; stop calling it for this run. */
const deadProviders = new Set<string>();
export const resetDeadProviders = () => deadProviders.clear();
const isAuthError = (m: string) => /\b40[13]\b|authenticat|user not found|invalid api key|unauthori[sz]ed/i.test(m);

/**
 * A chain of OpenAI-compatible fallbacks, tried in order when Gemini is out of quota.
 *
 * One backup is not enough: when it is also rate-limited the whole pipeline stops. Free tiers that
 * need no card, measured September 2026:
 *   Mistral La Plateforme  ~1B tokens/month (Experiment tier)   https://api.mistral.ai/v1
 *   Groq                   30 RPM · 1k req/day · 100k tokens/day https://api.groq.com/openai/v1
 *   Cerebras               30 RPM · 14.4k req/day · 1M tokens/day https://api.cerebras.ai/v1
 *   OpenRouter (:free)     20 RPM · 50 req/day without a top-up  https://openrouter.ai/api/v1
 *
 * LLM_FALLBACKS="name|baseUrl|apiKey|heavyModel|lightModel; name|..."
 */
export type Fallback = { name: string; baseUrl: string; apiKey: string; heavy: string; light: string };

export function fallbackChain(): Fallback[] {
  const chain: Fallback[] = [];
  // The original single-provider variables stay supported and go first.
  if (process.env.OPENAI_COMPAT_BASE_URL && process.env.OPENAI_COMPAT_API_KEY && process.env.OPENAI_COMPAT_MODEL_HEAVY) {
    chain.push({
      name: "openai-compat",
      baseUrl: process.env.OPENAI_COMPAT_BASE_URL,
      apiKey: process.env.OPENAI_COMPAT_API_KEY,
      heavy: process.env.OPENAI_COMPAT_MODEL_HEAVY,
      light: process.env.OPENAI_COMPAT_MODEL_LIGHT || process.env.OPENAI_COMPAT_MODEL_HEAVY,
    });
  }
  for (const entry of (process.env.LLM_FALLBACKS ?? "").split(";").map((x) => x.trim()).filter(Boolean)) {
    const [name, baseUrl, apiKey, heavy, light] = entry.split("|").map((x) => x.trim());
    if (name && baseUrl && apiKey && heavy) chain.push({ name, baseUrl, apiKey, heavy, light: light || heavy });
  }
  return chain;
}
/** The model stopped because it ran out of output budget — retryable with a smaller ask. */
export const isMaxTokens = (e: unknown) => /hit max tokens|MAX_TOKENS|finishReason.{0,12}length/i.test((e as Error)?.message ?? "");

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
/**
 * How much a provider will actually write in one answer. Measured, not guessed: a full script in
 * JSON runs 5-8k tokens, so anything under ~12k truncates it.
 */
function outputCapFor(base: string): number {
  if (process.env.OPENAI_COMPAT_MAX_TOKENS && base === (process.env.OPENAI_COMPAT_BASE_URL ?? "").replace(/\/$/, "")) {
    return Number(process.env.OPENAI_COMPAT_MAX_TOKENS); // legacy single-provider override
  }
  if (/mistral\.ai/.test(base)) return Number(process.env.MISTRAL_MAX_TOKENS ?? 32000);
  if (/bigmodel\.cn/.test(base)) return Number(process.env.ZAI_MAX_TOKENS ?? 32000);
  if (/groq\.com/.test(base)) return Number(process.env.GROQ_MAX_TOKENS ?? 8000);   // per-minute limit
  if (/openrouter\.ai/.test(base)) return Number(process.env.OPENROUTER_MAX_TOKENS ?? 16000);
  return 16000;
}

/**
 * Per-endpoint pacing. Mistral's limits page caps most models at 1.00 requests/second; exceeding it
 * returns 429, and a run that fires several calls in a burst limits itself out of its own quota.
 */
const lastCallAt = new Map<string, number>();
async function paceFor(endpoint: string, minGapMs = Number(process.env.PROVIDER_MIN_GAP_MS ?? 1100)) {
  const prev = lastCallAt.get(endpoint) ?? 0;
  const wait = prev + minGapMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt.set(endpoint, Date.now());
}

async function openaiCompatible(
  model: string, system: string, prompt: string, maxTokens: number, images?: string[],
  timeoutMs = LLM_TIMEOUT_HEAVY, baseUrl?: string, apiKey?: string,
): Promise<string> {
  const base = (baseUrl ?? process.env.OPENAI_COMPAT_BASE_URL ?? "").replace(/\/$/, "");
  await paceFor(base);
  // Output ceilings are per PROVIDER. A single global 4096 (added for Groq's per-minute limit)
  // silently truncated every Mistral script mid-JSON — a 13-scene script in JSON is well past it.
  const cap = outputCapFor(base);
  maxTokens = Math.min(maxTokens, cap);
  if (!base) throw new Error("Set OPENAI_COMPAT_BASE_URL (e.g. https://api.groq.com/openai/v1)");
  const content: unknown[] = [];
  for (const f of images ?? []) {
    content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${(await fs.promises.readFile(f)).toString("base64")}` } });
  }
  content.push({ type: "text", text: prompt });
  const res = await withRetry(() => fetchOk(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey ?? env("OPENAI_COMPAT_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: images?.length ? content : prompt }],
      max_tokens: maxTokens,
      temperature: 0.8,
      response_format: { type: "json_object" },
    }),
  }, timeoutMs), `openai-compat ${model}`, 3).catch((e: Error) => {
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
  const j = (await res.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  usage.calls++;
  usage.inputTokens += j.usage?.prompt_tokens ?? 0;
  usage.outputTokens += j.usage?.completion_tokens ?? 0;
  const text = j.choices?.[0]?.message?.content;
  if (!text) throw new Error(`${model} returned no content: ${JSON.stringify(j).slice(0, 300)}`);
  // A cut-off answer is not a bad answer — it is an answer that ran out of room. Say so plainly,
  // or it surfaces as a baffling JSON parse error and the call silently moves to another provider.
  if (j.choices?.[0]?.finish_reason === "length") {
    throw new TruncatedError(
      `${model} was cut off at max_tokens=${maxTokens} (${j.usage?.completion_tokens ?? "?"} tokens written). ` +
      `Raise the provider's cap (e.g. MISTRAL_MAX_TOKENS) — the answer did not fit.`);
  }
  return text;
}

/** An answer that stopped because it ran out of output room. */
export class TruncatedError extends Error {}

// ---------------- gemini (free key) ----------------
let lastGemini = 0;
async function geminiParts(images: string[] = []) {
  const parts: Record<string, unknown>[] = [];
  for (const f of images) {
    parts.push({ inline_data: { mime_type: f.endsWith(".png") ? "image/png" : "image/jpeg", data: (await fs.promises.readFile(f)).toString("base64") } });
  }
  return parts;
}

/** Hard ceiling on Gemini output, whatever we ask for. */
const GEMINI_OUTPUT_CAP = Number(process.env.GEMINI_OUTPUT_CAP ?? 8192);
/** Thinking models only; sending thinkingConfig to an older model is rejected. */
const supportsThinking = (model: string) => /gemini-(?:2\.5|3\.\d|omni)/i.test(model);

async function gemini(model: string, system: string, prompt: string, maxTokens: number, images?: string[], timeoutMs = LLM_TIMEOUT_HEAVY, thinkBudget = Number(process.env.GEMINI_THINKING_BUDGET ?? 1536)): Promise<string> {
  const wait = lastGemini + Number(process.env.GEMINI_MIN_GAP_MS ?? 7000) - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGemini = Date.now();
  const imageParts = await geminiParts(images); // read files once, outside the retry loop
  const res = await withRetry(() => fetchOk(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": env("GEMINI_API_KEY"), "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [...imageParts, { text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        // Flash caps output at 8192 however much you ask for; requesting 24k just hides the real limit.
        maxOutputTokens: Math.min(maxTokens, GEMINI_OUTPUT_CAP),
        temperature: 0.8,
        // On thinking models the reasoning spends the SAME allowance as the answer. Uncapped, it can
        // consume all 8192 and return MAX_TOKENS with no content — which is the failure we kept hitting.
        ...(supportsThinking(model) ? { thinkingConfig: { thinkingBudget: thinkBudget } } : {}),
      },
    }),
    // Two tries here, not five: the outer loop in geminiWithFallback now owns the patience (it waits
    // out overloads across ALL models). Five nested exponential retries per model per round stacked
    // to ~5.5 minutes per vision call during an outage.
  }, timeoutMs), `gemini ${model}`, Number(process.env.GEMINI_TRIES ?? 2)).catch((e: Error) => {
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
/** Transient: the model is overloaded right now. Waiting fixes it. */
const isOverload = (m: string) => /\b503\b|UNAVAILABLE|overload|high demand|try again later/i.test(m);
/** Daily/minute quota. Waiting minutes does not fix a daily quota; moving on does. */
const isQuotaMsg = (m: string) => /\b429\b|RESOURCE_EXHAUSTED|quota|rate/i.test(m);

async function geminiWithFallback(spec: string, system: string, prompt: string, maxTokens: number, images?: string[], timeoutMs = LLM_TIMEOUT_HEAVY, thinkBudget?: number): Promise<string> {
  const chain = spec.split(",").map((m) => m.trim()).filter(Boolean);
  // Every model busy at the same moment is a GLOBAL overload, which passes in seconds to minutes.
  // Moving straight to a backup provider (the old behaviour) turned a 30-second wait into a lost scene.
  const waits = [0, Number(process.env.GEMINI_BUSY_WAIT1_MS ?? 20_000), Number(process.env.GEMINI_BUSY_WAIT2_MS ?? 45_000)];
  let last: Error | undefined;
  for (const [round, wait] of waits.entries()) {
    if (wait) {
      console.warn(`    [llm] every Gemini model is overloaded; waiting ${Math.round(wait / 1000)}s before retrying (${round}/${waits.length - 1})`);
      await new Promise((r) => setTimeout(r, wait));
    }
    const order = [...chain.filter((m) => !geminiDown.has(m)), ...chain.filter((m) => geminiDown.has(m))];
    let allOverloaded = true;
    for (const model of order) {
      try {
        // timeout and thinking budget MUST be passed through: an earlier edit targeted a variable
        // name that did not exist, so for weeks neither reached Gemini at all (bug #73).
        const out = await gemini(model, system, prompt, maxTokens, images, timeoutMs, thinkBudget);
        geminiDown.delete(model);
        return out;
      } catch (e) {
        last = e as Error;
        const m = last.message;
        if (!isOverload(m) && !isQuotaMsg(m)) throw last;
        if (!isOverload(m)) allOverloaded = false;
        geminiDown.add(model);
        console.warn(`${model} is ${isOverload(m) ? "overloaded" : "out of quota"}; trying the next model listed in GEMINI_MODEL_* ...`);
      }
    }
    // Quota is not transient: waiting minutes will not help, so hand over to the fallbacks now.
    if (!allOverloaded) break;
  }
  throw new QuotaError(`Every model in "${spec}" is overloaded or out of quota.\nThe Gemini free tier resets at midnight Pacific. Add a backup provider to keep going (see SETUP.md "Backup provider").\n${last?.message.slice(0, 300)}`);
}

export function extractJson(text: string): unknown {
  const tagged = [...text.matchAll(/<json>([\s\S]*?)<\/json>/g)].pop()?.[1];
  const body = tagged ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(body.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
}

/** Calls the LLM and validates JSON output with zod; feeds validation errors back, 3 attempts. */
export async function askJson<T>(o: {
  tier: Tier;
  /** which job this call is doing; decides which provider handles it */
  role?: Role;
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
      // Shrink the ask on each retry: a second failure is usually the same overflow again.
      const budget = Math.max(3000, Math.round((o.maxTokens ?? 24000) * (attempt === 1 ? 1 : attempt === 2 ? 0.7 : 0.5)));

      // Role routing: a named provider takes the call, unless the role is unset or its key is missing.
      const routed = o.role && o.role !== "auto" ? ROLE_PROVIDER[o.role] : "";
      // The role names a preference, not the only option: every other configured provider is tried
      // before falling back to Gemini, because each free tier runs out in a different way.
      // A call carrying images can only go to a provider that can see. Of the free providers here
      // that is Gemini alone, so a vision call is never routed away from it.
      const needsSight = (o.images?.length ?? 0) > 0 || o.role === "vision";
      const order = routed && routed !== "gemini" && !needsSight
        ? [routed, ...Object.keys(NAMED).filter((n) => n !== routed)]
        : [];
      const live = order.filter((n) => NAMED[n]?.key && !deadProviders.has(n));
      const named = live.length ? NAMED[live[0]!] : undefined;
      const namedName = live[0] ?? routed;
      if (named?.key) {
        const m = o.tier === "heavy" ? named.heavy : named.light;
        console.log(`    [llm] ${o.role} -> ${namedName} (${m})`);
        try {
          const out = await openaiCompatible(m, o.system, body, Math.min(budget, o.maxTokens ?? 16000),
            o.images, timeoutFor(o.tier), named.baseUrl, named.key);
          try { raw = extractJson(out); } catch (e) { raw = undefined; lastErr = (e as Error).message; }
          const lastChance = attempt === 3 && o.role !== "write";
          if (raw === undefined && lastChance) {
            console.warn(`    [llm] ${namedName} still returning unparseable JSON — last attempt goes to ${PROVIDER}`);
          } else if (raw === undefined) {
            // Unparseable JSON from the routed provider. Previously this fell straight through to
            // Gemini in the same attempt, silently — which is how every run ended at Gemini's cap.
            console.warn(`    [llm] ${namedName} returned JSON that would not parse — retrying ${namedName}`);
            feedback = `\n\nYour previous answer was not valid JSON (${lastErr.slice(0, 120)}). ` +
              `Return ONE complete JSON object and nothing else.`;
            continue;
          }
          if (raw !== undefined) {
            const first = o.schema.safeParse(raw);
            if (first.success) return first.data;
            lastErr = first.error.message.slice(0, 1500);
            feedback = `\n\nYour previous answer was rejected by the validator:\n${lastErr}\nFix every listed problem.`;
            if (!lastChance) {
              const what = first.error.issues.slice(0, 2).map((i) => `${i.path.join(".") || "root"}: ${i.message}`).join("; ");
              console.warn(`    [llm] ${namedName} answer failed validation (${what.slice(0, 140)}) — retrying with the errors`);
              continue;
            }
            console.warn(`    [llm] ${namedName} failed validation 3 times — last attempt goes to ${PROVIDER}`);
          }
        } catch (err) {
          // Cut off mid-answer: the provider works, the answer just did not fit. Ask the SAME
          // provider again, more concisely — moving to another provider fixes nothing, and moving
          // to Gemini (8192-token ceiling) would be strictly worse.
          if (err instanceof TruncatedError && attempt < 3) {
            console.warn(`    [llm] ${namedName} ran out of room — retrying it more concisely`);
            lastErr = err.message;
            feedback = `\n\nYour previous answer was cut off before it finished. Keep every scene and every ` +
              `required field, but make descriptive fields (captions, alt queries, claims) terse so the ` +
              `whole object fits. Narration must NOT be shortened.`;
            continue;
          }
          // A routed provider failing is not fatal: fall through to the default path below.
          const msg = (err as Error).message;
          if (isAuthError(msg)) {
            deadProviders.add(namedName);
            console.warn(`    [llm] ${namedName} DISABLED for the rest of this run — its key was refused.`);
          }
          const hint = /\b403\b/.test(msg)
            ? ` — 403 usually means this key cannot use "${m}". Run \`npm run models:mistral\` to pick one it can.`
            : /\b401\b/.test(msg) ? " — 401: the key is wrong or not activated."
            : "";
          console.warn(`    [llm] ${namedName} failed: ${msg.slice(0, 160)}${hint}`);
          // Try every other configured provider before giving the call to Gemini.
          for (const nextName of order.filter((n) => n !== namedName)) {
            const next = NAMED[nextName];
            if (!next?.key || deadProviders.has(nextName)) continue;
            const nm = o.tier === "heavy" ? next.heavy : next.light;
            try {
              console.warn(`    [llm] trying ${nextName} (${nm})`);
              const out2 = await openaiCompatible(nm, o.system, body, Math.min(budget, o.maxTokens ?? 16000),
                o.images, timeoutFor(o.tier), next.baseUrl, next.key);
              const raw2 = extractJson(out2);
              const parsed2 = o.schema.safeParse(raw2);
              if (parsed2.success) return parsed2.data;
              lastErr = parsed2.error.message.slice(0, 1500);
            } catch (e2) {
              console.warn(`    [llm] ${nextName} failed: ${(e2 as Error).message.slice(0, 100)}`);
            }
          }
          // A writing call must not fall back to Gemini: its 8192-token output ceiling cannot hold
          // a full script, so the attempt only burns scarce quota and fails the same way. Better to
          // stop cleanly and let the next scheduled run try again.
          if (o.role === "write") {
            throw new Error(`every configured writing provider failed (${lastErr.slice(0, 160)}). ` +
              `Not falling back to Gemini: its output cap cannot hold a full script.`);
          }
          console.warn(`    [llm] all configured providers failed; using ${PROVIDER}`);
        }
      }

      const text = PROVIDER === "anthropic" ? await anthropic(model, o.system, body, o.maxTokens ?? 32000)
        : PROVIDER === "openai-compatible" ? await openaiCompatible(model, o.system, body, o.maxTokens ?? 16000, o.images, timeoutFor(o.tier))
        : await geminiWithFallback(model, o.system, body, budget, o.images, timeoutFor(o.tier),
            // Writing passes produce the most text and need no reasoning; giving thinking a share
            // of the 8192 output budget is what made expand hit MAX_TOKENS.
            o.role === "write" ? 0 : undefined).catch(async (e) => {
            // Ran out of output budget. On thinking models the cure is to stop it thinking — the
            // reasoning was eating the same 8192 tokens the answer needed.
            if (isMaxTokens(e)) {
              console.warn("    [llm] output budget exhausted by reasoning; retrying with thinking disabled");
              return geminiWithFallback(model, o.system, body, budget, o.images, timeoutFor(o.tier), 0);
            }
            if (!isQuota(e)) throw e;
            const chain = fallbackChain().filter((fb) => !deadProviders.has(fb.name));
            if (!chain.length) throw e;
            // A call carrying images must never go to a model that cannot see them: the images
            // were silently dropped and a blind model "ranked" a contact sheet it never saw.
            const seesImages = process.env.OPENAI_COMPAT_VISION === "true";
            if ((o.images?.length ?? 0) > 0 && !seesImages) throw e;
            // Walk the whole chain: each provider has its own free-tier limit, so one being
            // exhausted says nothing about the next.
            const failures: string[] = [];
            for (const fb of chain) {
              const model = o.tier === "heavy" ? fb.heavy : fb.light;
              try {
                console.warn(`    [llm] Gemini unavailable — trying ${fb.name} (${model})`);
                return await openaiCompatible(model, o.system, body, Math.min(budget, o.maxTokens ?? 16000),
                  seesImages ? o.images : undefined, timeoutFor(o.tier), fb.baseUrl, fb.apiKey);
              } catch (err) {
                const m = (err as Error).message;
                failures.push(`${fb.name}: ${m.slice(0, 80)}`);
                if (isAuthError(m)) {
                  deadProviders.add(fb.name);
                  console.warn(`    [llm] ${fb.name} DISABLED for the rest of this run — its key was refused (${m.slice(0, 60)}). ` +
                    `Fix or remove it in .env, then npm run github.`);
                } else {
                  console.warn(`    [llm] ${fb.name} failed: ${m.slice(0, 90)}`);
                }
              }
            }
            // Report the ORIGINAL cause. Rethrowing the last fallback's 401 made callers treat a
            // capacity problem (Gemini overloaded) as a bad answer, and abandon good work.
            throw new QuotaError(`${(e as Error).message}\nFallbacks also failed: ${failures.join("; ")}`);
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
