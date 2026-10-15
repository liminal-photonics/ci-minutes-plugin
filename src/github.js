// Read-only GitHub REST client. Token from GITHUB_TOKEN or GH_TOKEN; it is never logged or put in errors.
const BASE = process.env.GITHUB_API_URL || "https://api.github.com";
const TIMEOUT_MS = Number(process.env.CI_MINUTES_TIMEOUT_MS) || 20000;

export function token() {
  const t = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
  return t && !t.startsWith("${") ? t : "";
}

export async function gh(path, { allow404 = false, retry = true } = {}) {
  const t = token();
  if (!t) throw new Error("Set GITHUB_TOKEN (a fine-grained token with read-only Actions and Contents access, or a classic token with repo scope for private repos).");
  let res;
  try {
    res = await fetch(path.startsWith("http") ? path : `${BASE}${path}`, {
      headers: { Authorization: `Bearer ${t}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ci-minutes-plugin" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (e.name === "TimeoutError" || e.name === "AbortError") throw new Error(`GitHub timed out after ${TIMEOUT_MS / 1000} s`);
    throw new Error(`GitHub network error: ${e.message}`);
  }
  const limited = res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
  if (limited) {
    const after = Number(res.headers.get("retry-after"));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const wait = after || (reset ? Math.max(0, reset - Date.now() / 1000) : 0);
    if (retry && wait > 0 && wait <= 5 && !process.env.NO_RETRY_429) { await new Promise((r) => setTimeout(r, wait * 1000)); return gh(path, { allow404, retry: false }); }
    throw new Error(`GitHub rate limit reached${wait ? `; resets in about ${Math.ceil(wait / 60)} min` : ""}. Try a shorter period or fewer runs.`);
  }
  if (res.status === 401) throw new Error("GitHub rejected the token (401). Check that GITHUB_TOKEN is valid and not expired.");
  if (res.status === 404 && allow404) return null;
  if (res.status === 404) throw new Error("Not found (404): the repository or account doesn't exist, or the token can't see it.");
  if (res.status === 403) throw new Error("GitHub denied access (403): the token lacks permission for this (Actions read, or admin for billing).");
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
  return { body: await res.json(), link: res.headers.get("link") || "" };
}

const next = (link) => (link.match(/<([^>]+)>;\s*rel="next"/) || [])[1];

// Follow pagination up to maxItems. key = array field in the response (e.g. "workflow_runs").
export async function paged(path, key, maxItems = 1000) {
  const out = [];
  let url = path + (path.includes("?") ? "&" : "?") + "per_page=100";
  let total = null;
  while (url && out.length < maxItems) {
    const r = await gh(url);
    const items = key ? r.body[key] || [] : r.body;
    if (key && total == null) total = r.body.total_count ?? null;
    out.push(...items);
    url = next(r.link);
  }
  return { items: out.slice(0, maxItems), total, truncated: Boolean(url) || out.length > maxItems };
}
