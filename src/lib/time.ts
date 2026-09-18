/** Wrap any promise in a hard deadline. Used so no single stage can stall a whole run. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} exceeded ${Math.round(ms / 1000)}s`)), ms); }),
  ]).finally(() => clearTimeout(timer!)) as Promise<T>;
}
