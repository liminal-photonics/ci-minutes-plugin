# CI Minutes (GitHub Actions usage)

A read-only MCP server and skill that shows where GitHub Actions minutes go and how to cut them.

## Tools

| Tool | What it does |
|---|---|
| `ci_repo_usage` | Per workflow for a period: runs, conclusions, triggering events, wall-clock minutes, job minutes (each job rounded up, as GitHub bills), minutes by runner OS, estimated billable minutes (× Linux 1, Windows 2, macOS 10; zero for public repos and self-hosted runners). Sorted by biggest consumer. |
| `ci_account_usage` | Top consumers across a user's or organization's recently pushed repositories, plus GitHub's billing usage totals when the token can read them. |
| `ci_run_timing` | GitHub's own billable timing for one run (endpoint is being retired; often returns zeros on the new billing platform, and the tool says so). |
| `ci_suggestions` | Reads `.github/workflows/*.yml` and lists concrete fixes with YAML: `paths-ignore`, branch filters, duplicate push + pull_request runs, `concurrency` with `cancel-in-progress`, frequent schedules, macOS/Windows runners, large matrices, missing `timeout-minutes`, missing dependency caching, plus `[skip ci]` and push batching. |
| `ci_status` | Whether a token is configured, which account, remaining API rate limit. Never shows the token. |

Nothing is written: no workflow edits, no run cancellations, no settings changes.

## Setup

Set `GITHUB_TOKEN` (or `GH_TOKEN`):
- Fine-grained token: repository access to the repos you want, permissions **Actions: read** and **Contents: read** (and **Metadata: read**, added automatically). For account billing totals, the token owner must be able to read billing (org admin/billing manager, or your own user with the **Plan: read** permission).
- Classic token: `repo` scope for private repositories (no scope needed for public ones), `read:org` for organization repos.

Optional: `GITHUB_API_URL` for GitHub Enterprise Server, `CI_MINUTES_TIMEOUT_MS` (default 20000).

## Accuracy

- Job minutes come from each job's start and end time, rounded up per job. In live checks they matched `gh run view` exactly.
- Runner OS comes from job labels; jobs on self-hosted runners count as 0 billable.
- Larger runners have different per-minute rates and aren't modeled; the estimate treats them as standard runners of the same OS.
- Public repositories on standard runners are free; the tool reports their minutes but estimates 0 billable.
- GitHub's per-run billable timing API is being retired and now often returns zero; GitHub's billing page or usage report is the authority.
- Large periods are capped by `maxRuns` (default 300) to protect your API rate limit (5000 requests/hour); the result says when it was truncated.
- HTTP 429 and secondary rate limits wait once (up to 5 s) and otherwise return a clear message. Requests time out after 20 s.

## Development

```
npm install
npm test        # offline tests
npm run live    # live smoke test, needs GITHUB_TOKEN (SPEC=github:liminal-photonics/ci-minutes-plugin#<sha> for a fresh npx install)
```

## License

MIT © Liminal Photonics
