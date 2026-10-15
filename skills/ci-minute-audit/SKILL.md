---
name: ci-minute-audit
description: Audit GitHub Actions minute usage for a repository or account and recommend concrete savings (path filters, concurrency cancel-in-progress, branch filters, cheaper runners, smaller matrices, timeouts, caching, [skip ci]). Use when Actions minutes are running out, a bill looks high, or someone asks which workflows use the most CI time.
---

# CI minute audit

Read-only. Never edit workflows, push, cancel runs or change settings yourself; propose changes as a diff for the user to approve.

1. `ci_status` to confirm the token works (never ask the user to paste a token into chat; it belongs in `GITHUB_TOKEN`).
2. Account-wide question → `ci_account_usage` for the owner over the period (default 30 days). Single repo → `ci_repo_usage`.
3. Explain the numbers:
   - **job minutes**: each job rounded up to the minute (how GitHub bills);
   - **estimated billable**: × OS multiplier (Linux 1, Windows 2, macOS 10); zero for public repos on standard runners and for self-hosted runners;
   - GitHub's billing page is authoritative; these are estimates. If the billing API is available, show its total next to the estimate.
   - If results say runs were truncated, say so and offer to rerun with a higher limit.
4. For the top 1-3 consumers, run `ci_suggestions` and present the highest-impact fixes first (high → low), each with the exact YAML change.
5. Always mention the behavior changes too: `[skip ci]` on docs-only and housekeeping commits, batching pushes, testing locally first.
6. Estimate savings only from the data (e.g. "path filters would have skipped the 14 docs-only runs, about 40 minutes"); don't invent percentages.
