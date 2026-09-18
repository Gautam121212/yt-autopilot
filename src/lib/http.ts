/** Retries transient failures (429/5xx/network) with exponential backoff. */
/** undici hides the real network error inside .cause — without this every failure reads "fetch failed". */
export function describe(e: unknown): string {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  const cause = err?.cause?.code ?? err?.cause?.message;
  return cause ? `${err.message} (${cause})` : (err?.message ?? String(e));
}

export async function withRetry<T>(fn: () => Promise<T>, label: string, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const status = (e as { status?: number }).status;
      const msg = describe(e);
      // A 429 about request SIZE is permanent for this request; retrying it just wastes attempts.
      const permanent429 = /Request too large|enforced limit|tokens per minute|OTPM|reduce max_tokens/i.test(msg);
      const transient = status ? (status >= 500 || (status === 429 && !permanent429)) : e instanceof TypeError;
      if (!transient) throw e;
      // Network-level failures (reset, DNS, TLS) deserve a longer, jittered wait than a plain 5xx.
      const network = e instanceof TypeError || /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|UND_ERR/i.test(msg);
      const base = network ? 5000 : 2000;
      await new Promise((r) => setTimeout(r, base * 2 ** i + Math.random() * 1000));
    }
  }
  throw new Error(`${label} failed after ${tries} attempts: ${describe(last)}`);
}

/** Every network call needs a deadline: a socket that never answers used to stall the whole job. */
// Generous: one good slow run beats a fast thin one. A stalled socket is still capped.
export const NET_TIMEOUT_MS = Number(process.env.NET_TIMEOUT_MS ?? 30_000);

export function hfetch(url: string, init: RequestInit = {}, timeoutMs = NET_TIMEOUT_MS): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function fetchOk(url: string, init: RequestInit, timeoutMs = NET_TIMEOUT_MS): Promise<Response> {
  const res = await hfetch(url, init, timeoutMs);
  if (!res.ok) throw new HttpError(res.status, `${init.method ?? "GET"} ${url} -> ${res.status}: ${(await res.text()).slice(0, 800)}`);
  return res;
}
