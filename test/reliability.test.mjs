// Reliability fixes (audit 2026-10-17): the status tool reports the plugin version and git commit, and every
// result carries retrievedAt plus the plugin version. Network-free: data sources point at a closed local port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { pluginVersion, stamp } from "../src/version.js";

const SERVER = fileURLToPath(new URL("../src/index.js", import.meta.url));
const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const DEAD = "http://127.0.0.1:9";
async function client(extra = {}) {
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, GITHUB_API_URL: DEAD, GITHUB_TOKEN: "", ...extra } }));
  return c;
}
const body = (r) => JSON.parse(r.content[0].text);

test("status tool reports plugin name, version and git commit", async () => {
  const c = await client({ PLUGIN_GIT_SHA: "abc1234def".padEnd(40, "0") });
  try {
    const r = await c.callTool({ name: "ci_status", arguments: {} });
    const s = body(r);
    assert.equal(s.pluginName, PKG.name);
    assert.equal(s.plugin.name, PKG.name);
    assert.equal(s.version, PKG.version);
    assert.equal(s.version, "0.2.0");
    assert.equal(s.gitSha, "abc1234def".padEnd(40, "0"));
    assert.equal(s.gitShaSource, "PLUGIN_GIT_SHA");
    assert.match(s.retrievedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  } finally { await c.close(); }
});

test("every tool result is stamped with retrievedAt and plugin version", async () => {
  const c = await client();
  try {
    const r = await c.callTool({ name: "ci_suggestions", arguments: { repo: "" } });
    if (r.isError) return assert.ok(r.content[0].text.length > 0); // errors stay plain text
    const s = body(r);
    assert.match(s.retrievedAt, /Z$/);
    assert.equal(s.plugin.version, "0.2.0");
    assert.ok(s.plugin.gitSha);
  } finally { await c.close(); }
});

test("server advertises the package.json version, and mcp.json pins a tag", async () => {
  const c = await client();
  try { assert.equal(c.getServerVersion().version, PKG.version); } finally { await c.close(); }
  const m = readFileSync(new URL("../mcp.json", import.meta.url), "utf8");
  assert.match(m, /#v0\.2\.0"/);
  const p = JSON.parse(readFileSync(new URL("../.cursor-plugin/plugin.json", import.meta.url), "utf8"));
  assert.equal(p.version, PKG.version);
});

test("stamp wraps arrays and keeps objects", () => {
  const a = stamp([1, 2]);
  assert.deepEqual(a.result, [1, 2]);
  assert.ok(a.retrievedAt);
  const o = stamp({ x: 1 });
  assert.equal(o.x, 1);
  assert.equal(o.plugin.version, pluginVersion().version);
});

test("usage estimates say whether they are complete and how to report them", async () => {
  const { estimateInfo } = await import("../src/usage.js");
  const full = estimateInfo({});
  assert.equal(full.isEstimate, true);
  assert.equal(full.complete, true);
  assert.deepEqual(full.gaps, []);
  assert.match(full.howToReport, /estimate/);
  const part = estimateInfo({ truncated: true, partialJobs: true, skippedRepos: 3, billingAvailable: true });
  assert.equal(part.complete, false);
  assert.equal(part.gaps.length, 3);
  assert.match(part.howToReport, /lower bound/);
  assert.match(part.authoritativeSource, /billing/);
});
