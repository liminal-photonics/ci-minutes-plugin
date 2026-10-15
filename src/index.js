#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { repoUsage, accountUsage, runTiming } from "./usage.js";
import { suggestions } from "./suggest.js";
import { token, gh } from "./github.js";

const TOOLS = [
  { name: "ci_repo_usage", description: "GitHub Actions usage for one repository over a period: runs, wall-clock time and job minutes per workflow, minutes by runner OS, estimated billable minutes (each job rounded up × OS multiplier; zero for public repos on standard runners), sorted by biggest consumer. Read-only.",
    inputSchema: { type: "object", properties: { repo: { type: "string", description: "owner/name" }, days: { type: "integer", minimum: 1, maximum: 400, default: 30 }, maxRuns: { type: "integer", minimum: 1, maximum: 2000, default: 300 }, includeJobs: { type: "boolean", default: true } }, required: ["repo"] } },
  { name: "ci_account_usage", description: "Top Actions consumers across a user's or organization's recently pushed repositories, plus GitHub's billing usage totals when the token has access. Read-only.",
    inputSchema: { type: "object", properties: { owner: { type: "string" }, days: { type: "integer", minimum: 1, maximum: 400, default: 30 }, maxRepos: { type: "integer", minimum: 1, maximum: 200, default: 30 }, maxRunsPerRepo: { type: "integer", minimum: 1, maximum: 1000, default: 100 } }, required: ["owner"] } },
  { name: "ci_run_timing", description: "GitHub's own billable timing for one workflow run, by runner OS (the endpoint is closing down on GitHub's new billing platform and may return nothing).",
    inputSchema: { type: "object", properties: { repo: { type: "string" }, runId: { type: "integer" } }, required: ["repo", "runId"] } },
  { name: "ci_suggestions", description: "Read a repository's workflow files and suggest concrete ways to cut Actions minutes: path filters, concurrency with cancel-in-progress, branch filters, schedule frequency, macOS/Windows runners, matrix size, timeouts, caching and [skip ci]. Read-only; it never edits files.",
    inputSchema: { type: "object", properties: { repo: { type: "string" }, days: { type: "integer", default: 30, description: "Period for ranking the biggest consumers." } }, required: ["repo"] } },
  { name: "ci_status", description: "Check whether a GitHub token is configured and which account it belongs to (never shows the token).", inputSchema: { type: "object", properties: {} } },
];

const H = {
  ci_repo_usage: repoUsage,
  ci_account_usage: accountUsage,
  ci_run_timing: runTiming,
  ci_suggestions: async (a) => { const u = await repoUsage({ repo: a.repo, days: a.days || 30, maxRuns: 200 }).catch(() => null); return suggestions({ repo: a.repo, usage: u }); },
  ci_status: async () => {
    if (!token()) return { token: "missing: set GITHUB_TOKEN (read-only Actions + Contents for fine-grained tokens)" };
    const me = await gh("/user", { allow404: true }).catch((e) => ({ error: e.message }));
    const rl = await gh("/rate_limit").catch(() => null);
    return { token: me?.error ? `configured but not working: ${me.error}` : "configured", account: me?.body?.login || null, rateLimitRemaining: rl?.body?.resources?.core?.remaining ?? null };
  },
};

const server = new Server({ name: "ci-minutes", version: "0.1.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  try {
    if (!H[name]) throw new Error(`Unknown tool ${name}`);
    return { content: [{ type: "text", text: JSON.stringify(await H[name](a || {}), null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: e.message }] };
  }
});
await server.connect(new StdioServerTransport());
