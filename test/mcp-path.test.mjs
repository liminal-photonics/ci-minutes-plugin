// End-to-end tests through the MCP tool path: spawn the stdio server against a local mock GitHub API.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = fileURLToPath(new URL("../src/index.js", import.meta.url));
let mock, base, workflow = "", urls = [], slowJobsMs = 0, failJobs = false;
before(async () => {
  mock = http.createServer((req, res) => {
    urls.push(req.url);
    const send = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url.startsWith("/repos/o/r/contents/.github/workflows/")) return send({ content: Buffer.from(workflow).toString("base64") });
    if (req.url.startsWith("/repos/o/r/contents/.github/workflows")) return send([{ type: "file", name: "ci.yml", path: ".github/workflows/ci.yml" }]);
    if (req.url.startsWith("/repos/o/r/actions/runs/") && req.url.includes("/jobs") && failJobs && /runs\/1\//.test(req.url)) { res.writeHead(502); return res.end("bad gateway"); }
    if (req.url.startsWith("/repos/o/r/actions/runs/") && req.url.includes("/jobs")) return setTimeout(() => send({ total_count: 1, jobs: [{ started_at: "2026-01-01T00:00:00Z", completed_at: "2026-01-01T00:01:30Z", labels: ["ubuntu-latest"] }] }), slowJobsMs);
    if (req.url.startsWith("/repos/o/r/actions/runs")) return send({ total_count: 20, workflow_runs: Array.from({ length: 20 }, (_, i) => i + 1).map((id) => ({ id, workflow_id: 1, name: "CI", path: ".github/workflows/ci.yml", status: "completed", conclusion: "success", event: "push", run_started_at: new Date(Date.now() - 3600e3).toISOString(), created_at: new Date(Date.now() - 3600e3).toISOString(), updated_at: new Date(Date.now() - 3000e3).toISOString(), head_commit: { message: "x" } })) });
    if (req.url.startsWith("/repos/o/r")) return send({ full_name: "o/r", private: false });
    send({});
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${mock.address().port}`;
});
after(() => mock.close());

async function scheduleFinding(cron) {
  workflow = `on:\n  schedule:\n    - cron: '${cron}'\nconcurrency:\n  group: x\n  cancel-in-progress: true\njobs:\n  a:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps: [{ run: echo }]\n`;
  const c = new Client({ name: "t", version: "1" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, GITHUB_API_URL: base, GITHUB_TOKEN: "" } }));
  try {
    const r = JSON.parse((await c.callTool({ name: "ci_suggestions", arguments: { repo: "o/r" } })).content[0].text);
    return r.findings.find((f) => /cron/i.test(JSON.stringify(f)));
  } finally { await c.close(); }
}

test("MCP ci_suggestions: cron frequency is counted, not guessed", async () => {
  let f = await scheduleFinding("*/15 * * * *");
  assert.equal(f.severity, "high"); assert.match(f.issue || f.finding || JSON.stringify(f), /96 runs\/day/);
  f = await scheduleFinding("0 */6 * * *");
  assert.equal(f.severity, "medium"); assert.match(JSON.stringify(f), /4 runs\/day/);
  f = await scheduleFinding("0,30 9-17 * * 1-5");
  assert.match(JSON.stringify(f), /18 runs\/day on the days it runs|90 runs\/week/);
  assert.equal(await scheduleFinding("0 3 * * *"), undefined);
  assert.equal(await scheduleFinding("0 9 * * 1"), undefined);
  f = await scheduleFinding("not a cron");
  assert.match(JSON.stringify(f), /could not read/i);
});

test("MCP ci_suggestions: ranking runs without one jobs call per run", async () => {
  urls = [];
  await scheduleFinding("0 3 * * *");
  assert.ok(urls.some((u) => u.startsWith("/repos/o/r/actions/runs")));
  assert.equal(urls.filter((u) => u.includes("/jobs")).length, 0);
});

test("MCP ci_repo_usage: slow job lookups stop at the time budget with a note instead of hanging", async () => {
  slowJobsMs = 1500;
  const c = new Client({ name: "t", version: "1" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, GITHUB_API_URL: base, GITHUB_TOKEN: "", CI_MINUTES_BUDGET_MS: "500" } }));
  try {
    const t0 = Date.now();
    const r = JSON.parse((await c.callTool({ name: "ci_repo_usage", arguments: { repo: "o/r" } })).content[0].text);
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(r.totals.runs, 20);
    assert.ok(r.notes.some((n) => /Time limit reached: job minutes cover 8 of 20 completed runs/.test(n)), JSON.stringify(r.notes));
    assert.equal(r.estimate.complete, false);
    assert.match(r.estimate.howToReport, /lower bound/);
  } finally { await c.close(); slowJobsMs = 0; }
});

test("MCP ci_repo_usage: a GitHub 502 on one run's jobs is reported, not fatal", async () => {
  failJobs = true;
  const c = new Client({ name: "t", version: "1" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, GITHUB_API_URL: base, GITHUB_TOKEN: "" } }));
  try {
    const r = await c.callTool({ name: "ci_repo_usage", arguments: { repo: "o/r" } });
    assert.ok(!r.isError, r.content[0].text);
    const j = JSON.parse(r.content[0].text);
    assert.ok(j.notes.some((n) => /error for the job list of 1 run/.test(n)));
    assert.equal(j.totals.jobMinutes, 19 * 2);
    assert.equal(j.estimate.complete, false);
    assert.ok(j.estimate.gaps.some((g) => /job lists/.test(g)));
  } finally { await c.close(); failJobs = false; }
});
