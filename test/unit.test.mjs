import { test } from "node:test";
import assert from "node:assert/strict";
import { jobMinutes, runnerOs, parseRepo, repoUsage } from "../src/usage.js";
import { analyzeWorkflow } from "../src/suggest.js";
import { paged, gh } from "../src/github.js";

const job = (labels, s, e, extra = {}) => ({ labels, started_at: s, completed_at: e, runner_name: "GitHub Actions 12", runner_group_name: "GitHub Actions", ...extra });

test("job minutes round up per job and apply OS multipliers", () => {
  assert.deepEqual(jobMinutes(job(["ubuntu-latest"], "2026-01-01T00:00:00Z", "2026-01-01T00:01:01Z")).roundedMinutes, 2);
  assert.equal(jobMinutes(job(["windows-latest"], "2026-01-01T00:00:00Z", "2026-01-01T00:00:30Z")).weightedMinutes, 2);
  assert.equal(jobMinutes(job(["macos-14"], "2026-01-01T00:00:00Z", "2026-01-01T00:03:00Z")).weightedMinutes, 30);
  assert.equal(jobMinutes(job(["self-hosted", "linux"], "2026-01-01T00:00:00Z", "2026-01-01T01:00:00Z")).weightedMinutes, 0);
  assert.equal(runnerOs(job(["my-runner"], null, null, { runner_name: "box-1", runner_group_name: "Default" })), "self-hosted");
  assert.equal(jobMinutes(job(["ubuntu-latest"], null, null)).roundedMinutes, 0); // skipped job
});

test("repo names are validated, URLs accepted", () => {
  assert.equal(parseRepo("https://github.com/a-b/c.d.git").full, "a-b/c.d");
  assert.throws(() => parseRepo("nope"), /owner\/name/);
  assert.throws(() => parseRepo(""), /owner\/name/);
});

test("workflow analysis flags the common minute wasters", () => {
  const f = analyzeWorkflow("ci.yml", `
on:
  push:
  pull_request:
  schedule:
    - cron: "*/15 * * * *"
jobs:
  test:
    runs-on: macos-latest
    strategy:
      matrix:
        node: [18, 20, 22]
        os: [a, b]
    steps:
      - uses: actions/setup-node@v4
`);
  const issues = f.map((x) => x.issue).join(" | ");
  for (const re of [/every push/, /every pull_request/, /both push and pull_request/, /No concurrency/, /Scheduled very often/, /macOS/, /matrix runs ~6/, /timeout-minutes/, /without caching/]) assert.match(issues, re);
  const good = analyzeWorkflow("ok.yml", `
on:
  push:
    branches: [main]
    paths-ignore: ['**.md']
concurrency:
  group: x
  cancel-in-progress: true
jobs:
  t:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/setup-node@v4
        with: { cache: npm }
`);
  assert.deepEqual(good, []);
  assert.equal(analyzeWorkflow("bad.yml", "on: [push\njobs:")[0].severity, "error");
});

test("pagination follows Link headers and stops at maxItems; missing token is a clear error", async () => {
  const f = globalThis.fetch, saved = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "t";
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    const page = Number(new URL(url).searchParams.get("page") || 1);
    const items = Array.from({ length: 100 }, (_, i) => ({ id: (page - 1) * 100 + i }));
    return new Response(JSON.stringify({ total_count: 350, workflow_runs: page < 4 ? items : items.slice(0, 50) }), { headers: page < 4 ? { link: `<https://api.github.com/x?per_page=100&page=${page + 1}>; rel="next"` } : {} });
  };
  try {
    const all = await paged("/x", "workflow_runs", 1000);
    assert.equal(all.items.length, 350); assert.equal(all.truncated, false); assert.equal(calls, 4);
    const some = await paged("/x", "workflow_runs", 150);
    assert.equal(some.items.length, 150); assert.equal(some.truncated, true);
    globalThis.fetch = async () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600) } });
    await assert.rejects(paged("/x", "workflow_runs"), /rate limit/);
    delete process.env.GITHUB_TOKEN;
    await assert.rejects(repoUsage({ repo: "a/b" }), /Set GITHUB_TOKEN/);
  } finally { globalThis.fetch = f; if (saved) process.env.GITHUB_TOKEN = saved; }
});

test("edge cases: repo URL forms, include-only matrix, padded cron, secondary rate limit, bad JSON, empty page", async () => {
  assert.equal(parseRepo("https://github.com/a/b/").full, "a/b");
  assert.equal(parseRepo("github.com/a/b.git").full, "a/b");
  assert.equal(parseRepo("https://github.com/a/b/actions/runs/1").full, "a/b");
  const inc = analyzeWorkflow("w.yml", "on: { workflow_dispatch: {} }\nconcurrency: { group: x, cancel-in-progress: true }\njobs:\n  t:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    strategy:\n      matrix:\n        include: [{a: 1}, {a: 2}, {a: 3}, {a: 4}, {a: 5}]\n    steps: []\n");
  assert.ok(!inc.some((x) => /matrix/.test(x.issue)), "5 include-only entries are 5 jobs, not 6");
  const cr = analyzeWorkflow("c.yml", "on:\n  schedule:\n    - cron: ' */5 * * * *'\njobs: {}\n");
  assert.ok(cr.some((x) => x.severity === "high"));
  const f = globalThis.fetch, saved = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token"; process.env.NO_RETRY_429 = "1";
  try {
    globalThis.fetch = async () => new Response("{}", { status: 403, headers: { "retry-after": "60" } });
    await assert.rejects(gh("/x"), /rate limit/);
    globalThis.fetch = async () => new Response("<html>oops", { status: 200 });
    await assert.rejects(gh("/x"), /not valid JSON/);
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ total_count: 5000, workflow_runs: [] }), { headers: { link: '<https://api.github.com/x?page=2>; rel="next"' } }); };
    const p = await paged("/x", "workflow_runs", 2000);
    assert.equal(calls, 1); assert.equal(p.items.length, 0);
  } finally { globalThis.fetch = f; delete process.env.NO_RETRY_429; if (saved) process.env.GITHUB_TOKEN = saved; else delete process.env.GITHUB_TOKEN; }
});
