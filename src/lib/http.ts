/** Retries transient failures (429/5xx/network) with exponential backoff. */
export async function withRetry<T>(fn: () => Promise<T>, label: string, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const status = (e as { status?: number }).status;
      const msg = (e as Error).message ?? "";
      // A 429 about request SIZE is permanent for this request; retrying it just wastes attempts.
      const permanent429 = /Request too large|enforced limit|tokens per minute|OTPM|reduce max_tokens/i.test(msg);
      const transient = status ? (status >= 500 || (status === 429 && !permanent429)) : e instanceof TypeError;
      if (!transient) throw e;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
    }
  }
  throw new Error(`${label} failed after ${tries} attempts: ${String(last)}`);
}

/** Every network call needs a deadline: a socket that never answers used to stall the whole job. */
export const NET_TIMEOUT_MS = Number(process.env.NET_TIMEOUT_MS ?? 45_000);

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
