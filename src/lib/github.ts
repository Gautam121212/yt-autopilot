import { env } from "../config";
import { fetchOk } from "./http";

const api = (p: string) => `https://api.github.com/repos/${env("GITHUB_REPOSITORY")}${p}`;
const headers = () => ({
  Authorization: `Bearer ${env("GITHUB_TOKEN")}`,
  Accept: "application/vnd.github+json",
  "Content-Type": "application/json",
});

export async function createIssue(title: string, body: string, labels: string[] = []): Promise<number> {
  const res = await fetchOk(api("/issues"), { method: "POST", headers: headers(), body: JSON.stringify({ title, body, labels }) });
  return ((await res.json()) as { number: number }).number;
}
export async function comment(issue: number, body: string) {
  await fetchOk(api(`/issues/${issue}/comments`), { method: "POST", headers: headers(), body: JSON.stringify({ body }) });
}
export async function closeIssue(issue: number) {
  await fetchOk(api(`/issues/${issue}`), { method: "PATCH", headers: headers(), body: JSON.stringify({ state: "closed" }) });
}
export async function listComments(issue: number): Promise<{ body: string; user: { login: string } }[]> {
  const res = await fetchOk(api(`/issues/${issue}/comments?per_page=100`), { method: "GET", headers: headers() });
  return (await res.json()) as { body: string; user: { login: string } }[];
}
