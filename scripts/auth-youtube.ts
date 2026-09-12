/**
 * `npm run auth:youtube` (on your Mac, once).
 * Needs YT_CLIENT_ID / YT_CLIENT_SECRET in .env, OAuth client type "Web application"
 * with redirect URI http://localhost:5858/callback, consent screen "In production".
 * Writes YT_REFRESH_TOKEN into .env for you.
 */
import fs from "node:fs";
import http from "node:http";
import { google } from "googleapis";

const { YT_CLIENT_ID, YT_CLIENT_SECRET } = process.env;
if (!YT_CLIENT_ID || !YT_CLIENT_SECRET) throw new Error("Run `npm run setup` first");
const redirect = "http://localhost:5858/callback";
const oauth = new google.auth.OAuth2(YT_CLIENT_ID, YT_CLIENT_SECRET, redirect);

const url = oauth.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.force-ssl",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
  ],
});
console.log(`\n1) Open this link in your browser.\n2) Choose the Google account / brand account that OWNS the channel.\n3) If you see "Google hasn't verified this app": Advanced -> Go to (unsafe). It's your own app.\n\n${url}\n`);

http.createServer(async (req, res) => {
  const code = new URL(req.url ?? "", redirect).searchParams.get("code");
  if (!code) return res.end("no code");
  const { tokens } = await oauth.getToken(code);
  if (!tokens.refresh_token) {
    res.end("No refresh token returned. Remove the app at myaccount.google.com/permissions and run again.");
    process.exit(1);
  }
  const envText = fs.readFileSync(".env", "utf8");
  fs.writeFileSync(".env", /^YT_REFRESH_TOKEN=.*$/m.test(envText)
    ? envText.replace(/^YT_REFRESH_TOKEN=.*$/m, `YT_REFRESH_TOKEN=${tokens.refresh_token}`)
    : `${envText}\nYT_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  res.end("Done. You can close this tab and go back to the terminal.");
  console.log("✅ Refresh token saved into .env");
  process.exit(0);
}).listen(5858);
