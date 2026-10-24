/**
 * Shared yt-dlp CLI args. Addresses the "Sign in to confirm you're not a bot" bot-check that
 * YouTube serves to datacenter / CI IPs (GitHub Actions, Fly, Vercel, etc.):
 *
 *   1. Rotate player clients: --extractor-args "youtube:player_client=default,-tv,android,ios,web_safari"
 *      Different YouTube clients present different anti-bot gates. Trying several in order usually
 *      finds one that still answers unauthenticated. "default,-tv" says: use yt-dlp's default
 *      lineup, minus the TV client (which almost always demands sign-in from datacenters).
 *   2. Cookies: if YT_COOKIES_B64 is set (a base64-encoded cookies.txt), decode it to a temp file
 *      and pass --cookies <path>. This is the reliable fallback. The cookies file is session-bound
 *      so warn the user: if GH secret leaks, their YouTube session is compromised until they log
 *      out of youtube.com on the originating device.
 *
 * Any yt-dlp call in this project should go through COMMON() so both mitigations apply uniformly.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let cachedCookiesPath: string | undefined;

/** Decode YT_COOKIES_B64 into a temp cookies.txt on first use. Returns the path if available. */
function materializeCookies(): string | undefined {
  if (cachedCookiesPath) return cachedCookiesPath;
  const b64 = process.env.YT_COOKIES_B64;
  if (!b64) return undefined;
  const dir = mkdtempSync(path.join(tmpdir(), "yt-cookies-"));
  const file = path.join(dir, "cookies.txt");
  writeFileSync(file, Buffer.from(b64, "base64"));
  cachedCookiesPath = file;
  return file;
}

/** Prepend to any yt-dlp call. Returns [] on local shells with no bot-check issues, or
 *  the right flags on CI / blocked IPs. Always safe to include.
 *
 *  Cookie precedence (first match wins):
 *   1. YT_DLP_COOKIES_BROWSER (e.g. "safari", "chrome", "firefox") → --cookies-from-browser
 *      Used when running on the user's own Mac — reads cookies live from the installed browser,
 *      so no secret ever needs to be stored or refreshed.
 *   2. YT_COOKIES_B64 → decoded to a temp file, --cookies <file>
 *      Used on CI runners where there's no browser; the secret has to be refreshed periodically.
 *   3. Neither set → yt-dlp runs unauthenticated (may hit bot-check on datacenter IPs). */
export function ytdlpCommon(): string[] {
  const args: string[] = [
    "--extractor-args", "youtube:player_client=default,-tv,android,ios,web_safari",
    "--sleep-requests", "1",
  ];
  const browser = process.env.YT_DLP_COOKIES_BROWSER;
  if (browser) {
    args.push("--cookies-from-browser", browser);
    return args;
  }
  const cookies = materializeCookies();
  if (cookies) args.push("--cookies", cookies);
  return args;
}
