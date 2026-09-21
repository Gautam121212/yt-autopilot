/**
 * One Pexels budget for the whole run.
 *
 * Pexels allows 200 requests an hour. The fetch stage, the feasibility probe and the footage selector
 * all call it; a counter inside only one of them saw half the traffic and could not stop the rest
 * from hitting 429. Every Pexels request now takes from here first. Past the budget, callers fall
 * back to Pixabay (100 requests per MINUTE), which is why running out is graceful, not fatal.
 */
const LIMIT = Number(process.env.PEXELS_RUN_BUDGET ?? 150);
let used = 0;

/** True if a Pexels request may be made now; counts it. */
export function takePexels(): boolean {
  if (!process.env.PEXELS_API_KEY) return false;
  if (used >= LIMIT) return false;
  used++;
  return true;
}

export const pexelsUsed = () => used;
export const resetPexelsBudget = () => { used = 0; };
