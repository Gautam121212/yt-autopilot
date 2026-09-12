/** Retries transient failures (429/5xx/network) with exponential backoff. */
export async function withRetry<T>(fn: () => Promise<T>, label: string, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const status = (e as { status?: number }).status;
      const transient = status ? status >= 500 || status === 429 : e instanceof TypeError; // TypeError = network failure
      if (!transient) throw e;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
    }
  }
  throw new Error(`${label} failed after ${tries} attempts: ${String(last)}`);
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function fetchOk(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) throw new HttpError(res.status, `${init.method ?? "GET"} ${url} -> ${res.status}: ${(await res.text()).slice(0, 800)}`);
  return res;
}
