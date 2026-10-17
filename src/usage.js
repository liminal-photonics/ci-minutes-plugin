import { gh, paged } from "./github.js";

// GitHub-hosted runner minute multipliers for standard runners (docs.github.com, "About billing for GitHub Actions").
export const MULTIPLIER = { linux: 1, windows: 2, macos: 10 };

export function parseRepo(s) {
  const m = String(s || "").trim().replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "").replace(/\/(tree|blob|actions|pulls?|issues)(\/.*)?$/i, "").replace(/\/+$/, "").replace(/\.git$/, "").match(/^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/);
  if (!m) throw new Error('repo must look like "owner/name".');
  return { owner: m[1], name: m[2], full: `${m[1]}/${m[2]}` };
}

export function runnerOs(job) {
  const labels = (job.labels || []).map((l) => String(l).toLowerCase());
  if (labels.includes("self-hosted") || (job.runner_group_name && !/github actions/i.test(job.runner_group_name) && job.runner_name && !/^github actions/i.test(job.runner_name))) return "self-hosted";
  const l = labels.join(" ");
  if (/macos/.test(l)) return "macos";
  if (/windows/.test(l)) return "windows";
  if (/ubuntu|linux/.test(l)) return "linux";
  return "unknown";
}

const ms = (a, b) => (a && b ? Math.max(0, new Date(b) - new Date(a)) : 0);

// GitHub rounds each job up to the whole minute, then applies the OS multiplier.
export function jobMinutes(job) {
  const d = ms(job.started_at, job.completed_at);
  const os = runnerOs(job);
  const raw = d / 60000;
  const rounded = d > 0 ? Math.ceil(raw) : 0;
  const mult = MULTIPLIER[os] ?? 0;
  return { os, rawMinutes: raw, roundedMinutes: rounded, weightedMinutes: rounded * mult, multiplier: mult };
}

function sinceDate(days) {
  const d = Math.max(1, Math.min(400, Math.floor(Number(days) || 30)));
  return { days: d, iso: new Date(Date.now() - d * 86400000).toISOString().slice(0, 10) };
}

// Wall-clock budget for per-run job lookups, so one call stays well under client timeouts (a busy repo with 300 runs
// took over 2 minutes when every run's jobs were fetched one after another).
const BUDGET_MS = () => Number(process.env.CI_MINUTES_BUDGET_MS) || 20000;

export async function repoUsage({ repo, days = 30, maxRuns = 300, includeJobs = true, deadline } = {}) {
  const t0 = Date.now();
  const until = deadline ?? t0 + BUDGET_MS();
  const r = parseRepo(repo);
  const since = sinceDate(days);
  const limit = Math.max(1, Math.min(2000, Math.floor(Number(maxRuns) || 300)));
  const meta = (await gh(`/repos/${r.full}`)).body;
  const wf = await paged(`/repos/${r.full}/actions/workflows`, "workflows", 500);
  const runs = await paged(`/repos/${r.full}/actions/runs?created=%3E%3D${since.iso}`, "workflow_runs", limit);
  const byWf = new Map();
  for (const w of wf.items) byWf.set(w.id, { workflowId: w.id, name: w.name, path: w.path, state: w.state, runs: 0, conclusions: {}, events: {}, wallMinutes: 0, jobMinutes: 0, weightedMinutes: 0, byOs: {}, longestRunMinutes: 0, skipCiCommits: 0 });
  const notes = [];
  if (runs.truncated) notes.push(`Only the newest ${runs.items.length} of ${runs.total ?? "more"} runs were analyzed; raise maxRuns or shorten days for full coverage.`);
  // Fetch job details 8 runs at a time until the time budget runs out.
  const completed = includeJobs ? runs.items.filter((x) => x.status === "completed") : [];
  const jobsByRun = new Map();
  let next = 0, jobErrors = 0;
  await Promise.all(Array.from({ length: Math.min(8, completed.length) }, async () => {
    while (next < completed.length && Date.now() < until) {
      const run = completed[next++];
      try { jobsByRun.set(run.id, await paged(`/repos/${r.full}/actions/runs/${run.id}/jobs?filter=all`, "jobs", 500)); }
      catch (e) { if (/rate limit|401|403/i.test(e.message)) throw e; jobErrors++; } // one failed page (GitHub 502) should not sink the whole report
    }
  }));
  if (jobErrors) notes.push(`GitHub returned an error for the job list of ${jobErrors} run${jobErrors === 1 ? "" : "s"}; their job minutes are missing. Run again to fill them in.`);
  if (includeJobs && jobsByRun.size + jobErrors < completed.length) notes.push(`Time limit reached: job minutes cover ${jobsByRun.size} of ${completed.length} completed runs (the newest first); the other runs count toward runs and wall-clock time only. Use a smaller days or maxRuns for full job detail.`);
  for (const run of runs.items) {
    let w = byWf.get(run.workflow_id);
    if (!w) { w = { workflowId: run.workflow_id, name: run.name, path: run.path, state: "deleted or dynamic", runs: 0, conclusions: {}, events: {}, wallMinutes: 0, jobMinutes: 0, weightedMinutes: 0, byOs: {}, longestRunMinutes: 0, skipCiCommits: 0 }; byWf.set(run.workflow_id, w); }
    w.runs++;
    w.conclusions[run.conclusion || run.status] = (w.conclusions[run.conclusion || run.status] || 0) + 1;
    w.events[run.event] = (w.events[run.event] || 0) + 1;
    const wall = ms(run.run_started_at || run.created_at, run.updated_at) / 60000;
    w.wallMinutes += wall;
    w.longestRunMinutes = Math.max(w.longestRunMinutes, wall);
    const jobs = jobsByRun.get(run.id);
    if (jobs) {
      for (const j of jobs.items) {
        const m = jobMinutes(j);
        w.jobMinutes += m.roundedMinutes;
        w.weightedMinutes += m.weightedMinutes;
        w.byOs[m.os] = (w.byOs[m.os] || 0) + m.roundedMinutes;
      }
    }
  }
  const workflows = [...byWf.values()].map((w) => ({ ...w, wallMinutes: +w.wallMinutes.toFixed(1), longestRunMinutes: +w.longestRunMinutes.toFixed(1) })).sort((a, b) => b.weightedMinutes - a.weightedMinutes || b.wallMinutes - a.wallMinutes);
  const tot = workflows.reduce((t, w) => ({ runs: t.runs + w.runs, jobMinutes: t.jobMinutes + w.jobMinutes, weightedMinutes: t.weightedMinutes + w.weightedMinutes }), { runs: 0, jobMinutes: 0, weightedMinutes: 0 });
  if (!meta.private) notes.push("This repository is public: standard GitHub-hosted runners are free for public repos, so these minutes don't count against your quota. Larger runners are billed even for public repos.");
  notes.push("Estimated billable minutes = each job rounded up to the minute × OS multiplier (Linux 1, Windows 2, macOS 10), for standard GitHub-hosted runners. Self-hosted runners are not billed. GitHub's own billing page is authoritative.");
  return {
    repo: r.full, private: Boolean(meta.private), period: `since ${since.iso} (${since.days} days)`, runsAnalyzed: runs.items.length, totalRuns: runs.total,
    totals: { ...tot, estimatedBillableMinutes: meta.private ? tot.weightedMinutes : 0 },
    // An estimate, never a billing figure. complete:false means some runs or jobs were not counted, so the true figure
    // is higher; any summary must say so instead of quoting the number as exact.
    estimate: estimateInfo({ truncated: Boolean(runs.truncated), partialJobs: notes.some((n) => n.startsWith("Time limit reached")), jobErrors: notes.some((n) => /error for the job list/.test(n)) }),
    workflows, notes,
  };
}

export function estimateInfo({ truncated = false, partialJobs = false, jobErrors = false, skippedRepos = 0, repoErrors = 0, billingAvailable = false } = {}) {
  const gaps = [];
  if (truncated) gaps.push("only the newest runs or repositories were analyzed");
  if (partialJobs) gaps.push("job minutes were counted for only part of the runs (time limit)");
  if (jobErrors) gaps.push("GitHub returned an error for some runs' job lists, so those minutes are missing");
  if (repoErrors) gaps.push(`${repoErrors} repositories returned an error and were not counted`);
  if (skippedRepos) gaps.push(`${skippedRepos} repositories were skipped (time limit)`);
  return {
    isEstimate: true,
    complete: gaps.length === 0,
    gaps,
    authoritativeSource: billingAvailable ? "billing.actionsQuantity (GitHub billing usage report)" : "GitHub's billing page (the token cannot read billing)",
    howToReport: gaps.length ? "Report as a lower bound (\"at least N minutes, estimate\")." : "Report as an estimate (\"about N minutes, estimate\"), not as a billing figure.",
  };
}

// Official billable timing for one run (endpoint is closing down on the new billing platform; may 404/410).
export async function runTiming({ repo, runId } = {}) {
  const r = parseRepo(repo);
  if (!/^\d+$/.test(String(runId || ""))) throw new Error("runId must be a numeric workflow run ID.");
  const t = await gh(`/repos/${r.full}/actions/runs/${runId}/timing`, { allow404: true });
  if (!t) return { repo: r.full, runId, note: "GitHub returned no timing for this run (the timing endpoint is closing down on the new billing platform)." };
  const billable = Object.fromEntries(Object.entries(t.body.billable || {}).map(([os, v]) => [os, { minutes: +(v.total_ms / 60000).toFixed(2), jobs: v.jobs }]));
  const allZero = Object.values(t.body.billable || {}).every((v) => !v.total_ms);
  return { repo: r.full, runId: Number(runId), allZero, runDurationMinutes: t.body.run_duration_ms != null ? +(t.body.run_duration_ms / 60000).toFixed(2) : null, billable, note: allZero ? "GitHub returned zero billable time. That is expected for public repos and self-hosted runners; for private repos it usually means the timing endpoint is retired for this account (GitHub's new billing platform), so use ci_repo_usage estimates or the billing page." : "From GitHub's run timing endpoint: billable time before OS multipliers, not rounded." };
}

export async function accountUsage({ owner, days = 30, maxRepos = 30, maxRunsPerRepo = 100 } = {}) {
  const o = String(owner || "").trim();
  if (!/^[A-Za-z0-9-]+$/.test(o)) throw new Error("owner must be a GitHub user or organization login.");
  const acct = (await gh(`/users/${o}`)).body;
  const isOrg = acct.type === "Organization";
  const notes0 = [];
  // /users/{owner}/repos lists public repos only, even for your own account; use /user/repos for yourself.
  const me = isOrg ? null : (await gh("/user", { allow404: true }).catch(() => null))?.body?.login;
  const self = me && me.toLowerCase() === o.toLowerCase();
  const repos = await paged(isOrg ? `/orgs/${o}/repos?type=all&sort=pushed` : self ? "/user/repos?affiliation=owner&visibility=all&sort=pushed" : `/users/${o}/repos?type=owner&sort=pushed`, null, Math.max(1, Math.min(200, Number(maxRepos) || 30)));
  if (!isOrg && !self) notes0.push("Only public repositories are visible for another user's account.");
  const since = sinceDate(days);
  const rows = [], notes = [...notes0];
  const deadline = Date.now() + BUDGET_MS();
  let skippedForTime = 0, repoErrors = 0;
  for (const rp of repos.items) {
    if (rp.archived) continue;
    if (new Date(rp.pushed_at) < new Date(since.iso)) continue; // no pushes in the period, so (almost always) no push-triggered runs
    try {
      if (Date.now() >= deadline) { skippedForTime++; continue; }
      const u = await repoUsage({ repo: rp.full_name, days: since.days, maxRuns: maxRunsPerRepo, deadline });
      if (u.runsAnalyzed) rows.push({ repo: u.repo, private: u.private, runs: u.totals.runs, jobMinutes: u.totals.jobMinutes, estimatedBillableMinutes: u.totals.estimatedBillableMinutes, topWorkflow: u.workflows[0] ? `${u.workflows[0].name} (${u.workflows[0].jobMinutes} job-min)` : null, truncated: u.notes.some((n) => n.startsWith("Only the newest")), partialJobs: u.notes.some((n) => n.startsWith("Time limit reached")), jobErrors: u.notes.some((n) => /error for the job list/.test(n)) });
    } catch (e) { repoErrors++; notes.push(`${rp.full_name}: ${e.message}`); }
  }
  rows.sort((a, b) => b.estimatedBillableMinutes - a.estimatedBillableMinutes || b.jobMinutes - a.jobMinutes);
  if (skippedForTime) notes.push(`Time limit reached: ${skippedForTime} less recently pushed repositories were not checked. Use a smaller maxRepos or days, or check them one at a time with ci_repo_usage.`);
  if (rows.some((r) => r.partialJobs)) notes.push("Some repositories have job minutes for only part of their runs (time limit); see ci_repo_usage for one repository.");
  if (repos.truncated) notes.push(`Only the ${repos.items.length} most recently pushed repositories were checked; raise maxRepos to include more.`);
  notes.push("Repositories with no push in the period are skipped (scheduled-only workflows in those repos may be missed).");
  let billing = null;
  const b = await gh(isOrg ? `/organizations/${o}/settings/billing/usage` : `/users/${o}/settings/billing/usage`, { allow404: true }).catch((e) => ({ error: e.message }));
  if (b?.error) billing = { available: false, reason: b.error };
  else if (!b) billing = { available: false, reason: "Billing usage API not available for this account (needs the enhanced billing platform and admin/owner access)." };
  else {
    const items = (b.body.usageItems || []).filter((i) => /actions/i.test(i.product || "") && new Date(i.date) >= new Date(since.iso));
    const sum = (f) => +items.reduce((s, i) => s + (Number(i[f]) || 0), 0).toFixed(2);
    billing = { available: true, actionsQuantity: sum("quantity"), unit: items[0]?.unitType || "minutes", grossAmountUSD: sum("grossAmount"), netAmountUSD: sum("netAmount"), note: "From GitHub's billing usage report for the current billing year, filtered to the period." };
  }
  const estimate = estimateInfo({ truncated: Boolean(repos.truncated) || rows.some((r) => r.truncated), partialJobs: rows.some((r) => r.partialJobs), jobErrors: rows.some((r) => r.jobErrors), repoErrors, skippedRepos: skippedForTime, billingAvailable: Boolean(billing?.available) });
  return { owner: o, type: acct.type, period: `since ${since.iso}`, topConsumers: rows, estimate, billing, notes };
}
