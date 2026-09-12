import { google } from "googleapis";
import { env } from "../config";

function auth() {
  const o = new google.auth.OAuth2(env("YT_CLIENT_ID"), env("YT_CLIENT_SECRET"));
  o.setCredentials({ refresh_token: env("YT_REFRESH_TOKEN") });
  return o;
}
export const yt = () => google.youtube({ version: "v3", auth: auth() });
export const ytAnalytics = () => google.youtubeAnalytics({ version: "v2", auth: auth() });
