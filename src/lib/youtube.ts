import { google } from "googleapis";
import { env } from "../config";

function auth() {
  const o = new google.auth.OAuth2(env("YT_CLIENT_ID"), env("YT_CLIENT_SECRET"));
  o.setCredentials({ refresh_token: env("YT_REFRESH_TOKEN") });
  return o;
}
export const yt = () => google.youtube({ version: "v3", auth: auth() });

/**
 * Proves the upload credential works, cheaply, before any expensive stage runs. An expired refresh
 * token ("invalid_grant") otherwise surfaces only at upload — after research, writing, footage
 * selection and a 20-minute render have all been spent on a video that cannot be published.
 */
export async function checkUploadAuth(): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!process.env.YT_CLIENT_ID || !process.env.YT_CLIENT_SECRET || !process.env.YT_REFRESH_TOKEN) {
    return { ok: false, reason: "YT_CLIENT_ID / YT_CLIENT_SECRET / YT_REFRESH_TOKEN are not all set" };
  }
  try {
    const t = await auth().getAccessToken();
    return t?.token ? { ok: true } : { ok: false, reason: "Google returned no access token" };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    return { ok: false, reason: /invalid_grant/i.test(msg)
      ? "the YouTube refresh token has expired or been revoked (invalid_grant)"
      : msg.slice(0, 200) };
  }
}
export const ytAnalytics = () => google.youtubeAnalytics({ version: "v2", auth: auth() });
