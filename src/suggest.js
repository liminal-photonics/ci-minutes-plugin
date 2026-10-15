import YAML from "yaml";
import { gh } from "./github.js";
import { parseRepo } from "./usage.js";

const DOC_PATHS = ["**.md", "docs/**", "LICENSE"];

// Static checks on one workflow file. Returns findings with a concrete fix.
export function analyzeWorkflow(path, text) {
  const f = [];
  let doc;
  try { doc = YAML.parse(text); } catch (e) { return [{ path, severity: "error", issue: `YAML does not parse: ${e.message.split("\n")[0]}`, fix: "Fix the syntax; a broken workflow can fail on every push." }]; }
  if (!doc || typeof doc !== "object") return [{ path, severity: "error", issue: "Empty workflow file.", fix: "Delete it or add jobs." }];
  let on = doc.on ?? doc[true]; // YAML 1.1 parsers may read the bare key `on` as boolean true
  if (typeof on === "string") on = { [on]: null };
  if (Array.isArray(on)) on = Object.fromEntries(on.map((e) => [e, null]));
  on = on || {};
  const add = (severity, issue, fix) => f.push({ path, severity, issue, fix });
  for (const ev of ["push", "pull_request"]) {
    if (!(ev in on)) continue;
    const c = on[ev] || {};
    if (!c.paths && !c["paths-ignore"]) add("medium", `Runs on every ${ev}, including docs-only changes.`, `Add \`paths-ignore: [${DOC_PATHS.map((p) => `'${p}'`).join(", ")}]\` (or \`paths:\` for the code it tests) under \`on.${ev}\`.`);
    if (ev === "push" && !c.branches && !c["branches-ignore"] && !c.tags) add("low", "push trigger has no branch filter, so every branch push runs it.", "Limit with `branches: [main]` and rely on pull_request for feature branches.");
  }
  if ("push" in on && "pull_request" in on) {
    const pb = (on.push || {}).branches;
    if (!pb) add("medium", "Triggers on both push and pull_request without branch filters, so PR commits run twice.", "Restrict push to `branches: [main]`.");
  }
  if (!doc.concurrency) add("medium", "No concurrency group: superseded runs keep running.", "Add at the top level:\n```yaml\nconcurrency:\n  group: ${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: true\n```");
  else if (typeof doc.concurrency === "object" && !doc.concurrency["cancel-in-progress"]) add("low", "Concurrency group set but cancel-in-progress is off.", "Set `cancel-in-progress: true` (except for deploy workflows that must finish).");
  if (on.schedule) {
    for (const s of [].concat(on.schedule || [])) {
      const cron = String(s?.cron || "");
      const [min, hour] = cron.split(/\s+/);
      const perDay = (min.includes("*") || min.includes("/") || min.includes(",") ? 24 : 1) * (hour === "*" || hour?.includes("/") || hour?.includes(",") ? (hour === "*" ? 24 : hour.split(",").length || 2) : 1);
      if (/^\*|\//.test(min) || hour === "*") add("high", `Scheduled very often (cron "${cron}", up to ~${perDay}+ runs/day).`, "Run daily or weekly unless it truly needs more; scheduled runs bill even when nothing changed.");
    }
  }
  const jobs = doc.jobs || {};
  for (const [id, j] of Object.entries(jobs)) {
    if (!j || typeof j !== "object") continue;
    const ro = JSON.stringify(j["runs-on"] ?? "").toLowerCase();
    if (/macos/.test(ro)) add("high", `Job "${id}" runs on macOS (10× minutes).`, "Move steps that don't need macOS to ubuntu-latest; run macOS only on main or nightly.");
    if (/windows/.test(ro)) add("medium", `Job "${id}" runs on Windows (2× minutes).`, "Run Windows only where you ship Windows builds, or only on main.");
    if (j["timeout-minutes"] == null) add("low", `Job "${id}" has no timeout-minutes (default 360).`, "Set `timeout-minutes:` to about 2× its normal duration so hung jobs don't burn hours.");
    const m = j.strategy?.matrix;
    if (m && typeof m === "object") {
      const size = Object.entries(m).filter(([k]) => !["include", "exclude"].includes(k)).reduce((n, [, v]) => n * (Array.isArray(v) ? v.length : 1), 1) + (Array.isArray(m.include) ? m.include.length : 0) - (Array.isArray(m.exclude) ? m.exclude.length : 0);
      if (size >= 6) add("medium", `Job "${id}" matrix runs ~${size} jobs per trigger.`, "Run the full matrix on main or nightly and a small subset on pull requests.");
    }
    const steps = j.steps || [];
    const usesSetup = steps.some((s) => /actions\/setup-(node|python|java|go)/.test(s?.uses || ""));
    const cached = steps.some((s) => /actions\/cache/.test(s?.uses || "") || (s?.with && s.with.cache));
    if (usesSetup && !cached) add("low", `Job "${id}" installs dependencies without caching.`, "Use the setup action's `cache:` input (e.g. `cache: npm`) or actions/cache.");
  }
  return f;
}

export async function suggestions({ repo, usage } = {}) {
  const r = parseRepo(repo);
  const list = await gh(`/repos/${r.full}/contents/.github/workflows`, { allow404: true });
  if (!list) return { repo: r.full, workflows: 0, findings: [], general: ["No .github/workflows folder: this repository uses no Actions minutes."] };
  const files = (list.body || []).filter((x) => x.type === "file" && /\.ya?ml$/i.test(x.name));
  const findings = [];
  for (const file of files.slice(0, 50)) {
    const c = await gh(`/repos/${r.full}/contents/${encodeURIComponent(file.path).replace(/%2F/g, "/")}`);
    const text = Buffer.from(c.body.content || "", "base64").toString("utf8");
    findings.push(...analyzeWorkflow(file.path, text));
  }
  const order = { error: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  const general = [
    "For commits that only touch docs or bot housekeeping, put [skip ci] (or [ci skip], [no ci], [skip actions]) in the commit message; GitHub skips push and pull_request workflows for it.",
    "Batch commits and push once per finished change; every push can start every matching workflow.",
    "Test locally before pushing so CI isn't used for debugging.",
  ];
  if (usage?.workflows?.length) {
    const top = usage.workflows.filter((w) => w.jobMinutes > 0).slice(0, 3).map((w) => `${w.name}: ${w.jobMinutes} job-min, ${w.runs} runs`);
    if (top.length) general.unshift(`Biggest consumers in the period: ${top.join("; ")}. Fix those workflows first.`);
  }
  return { repo: r.full, workflows: files.length, findings, general };
}
