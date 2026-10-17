// Plugin version and build identity, so a caller can prove which build answered and date every result.
// gitSha comes from (1) PLUGIN_GIT_SHA, (2) the npx/npm lockfile that installed this package from GitHub
// ("resolved": "git+ssh://...#<sha>"), or (3) the .git folder of a source checkout. Otherwise "unknown".
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let cached = null;

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const SHA = /^[0-9a-f]{40}$/;

function shaFromLockfiles(name) {
  // Walk up from the package root (…/node_modules/<name>) and look for a lockfile that resolved this package.
  let dir = ROOT;
  for (let i = 0; i < 6; i++) {
    const lock = readJson(join(dir, "package-lock.json"));
    const entry = lock?.packages?.[`node_modules/${name}`];
    const m = String(entry?.resolved || "").match(/#([0-9a-f]{40})$/);
    if (m) return m[1];
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function shaFromGitDir() {
  const git = join(ROOT, ".git");
  if (!existsSync(git)) return null;
  try {
    const head = readFileSync(join(git, "HEAD"), "utf8").trim();
    if (SHA.test(head)) return head;
    const ref = head.replace(/^ref:\s*/, "");
    if (existsSync(join(git, ref))) { const s = readFileSync(join(git, ref), "utf8").trim(); if (SHA.test(s)) return s; }
    const packed = existsSync(join(git, "packed-refs")) ? readFileSync(join(git, "packed-refs"), "utf8") : "";
    const line = packed.split("\n").find((l) => l.endsWith(` ${ref}`));
    if (line && SHA.test(line.split(" ")[0])) return line.split(" ")[0];
  } catch { /* fall through */ }
  return null;
}

export function pluginVersion() {
  if (cached) return cached;
  const pkg = readJson(join(ROOT, "package.json")) || {};
  const env = String(process.env.PLUGIN_GIT_SHA || "").trim().toLowerCase();
  let gitSha = null, source = null;
  if (SHA.test(env)) { gitSha = env; source = "PLUGIN_GIT_SHA"; }
  if (!gitSha) { gitSha = shaFromLockfiles(pkg.name); if (gitSha) source = "npm lockfile"; }
  if (!gitSha) { gitSha = shaFromGitDir(); if (gitSha) source = "git checkout"; }
  cached = { name: pkg.name || null, version: pkg.version || null, gitSha: gitSha || "unknown", gitShaSource: source || "not found" };
  return cached;
}

// ISO 8601 UTC time for a result, e.g. "2026-10-17T17:05:00.000Z".
export const asOf = () => new Date().toISOString();

// Stamp a tool result with when it was retrieved and which build produced it.
export function stamp(out) {
  const v = pluginVersion();
  if (out && typeof out === "object" && !Array.isArray(out)) return { ...out, retrievedAt: asOf(), plugin: { name: v.name, version: v.version, gitSha: v.gitSha } };
  return { result: out, retrievedAt: asOf(), plugin: { name: v.name, version: v.version, gitSha: v.gitSha } };
}

// Fields for a *_status tool: plugin name, version, git commit and where the commit was read from.
// (The name is pluginName because stamp() adds a "plugin" object to every result.)
export function versionInfo() {
  const v = pluginVersion();
  return { pluginName: v.name, version: v.version, gitSha: v.gitSha, gitShaSource: v.gitShaSource };
}
