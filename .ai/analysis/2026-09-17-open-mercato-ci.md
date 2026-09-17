# open-mercato/open-mercato — CI analysis

**Date:** 2026-09-17
**Subject:** `github.com/open-mercato/open-mercato` (public, 1747 stars, 1109 open issues, default branch `main`, working branch `develop`)
**Question asked:** the repo reportedly has 3000+ tests — does it run e2e in GitHub CI, or are e2e run by the agent and reported in the PR instead, and therefore skipped as a CI gate?
**Method:** shallow clone at `852d0f7f` + `gh api` against real workflow runs. Every number below is measured, not estimated; the commands are inline so each claim can be re-checked.

## Answer

**e2e DO run in GitHub CI.** They are the `ephemeral-integration` job in `ci.yml` — Playwright on Chromium, 15 parallel shards on push.

The hypothesis is inverted: CI is the source of truth and the agent is explicitly told *not* to duplicate it. `.ai/skills/om-auto-review-pr/SKILL.md:12` — *"CI already runs the full validation gate on every PR. Prefer GitHub PR check results over re-running `validation.commands` locally"* — with local runs allowed **only as a fallback** when check data is unreadable.

The real problem is elsewhere: the `prepare` job's scope rules remove e2e from **one PR in three**, and the same rules disable `docker-build` on Docker-only changes.

## 1. Workflow inventory (13 files)

| File | Trigger | Role |
| --- | --- | --- |
| `ci.yml` (1153 lines) | push + PR on `main`/`develop`/`feat/wms` | the main gate: 10 jobs |
| `mutation-tests.yml` | PR | Stryker. **Advisory** — `continue-on-error` while `vars.MUTATION_ENFORCE != 'true'` (unset). Allowlist is a single package: `ALLOWLISTED_PACKAGES = ['shared']` |
| `audit.yml` | cron `17 6 * * *` | daily re-scan of the *unchanged* dependency graph. Deliberately a separate file: `ci.yml` uses `concurrency: ci-${{ github.ref }}` with `cancel-in-progress: true`, so a scheduled run there would cancel real CI |
| `snapshot.yml` | push on `develop` | npm snapshot publish + `standalone-integration`: the **full `yarn test:integration`** against a freshly scaffolded standalone app built from the published snapshot packages |
| `npm-snapshot-preview.yml`, `package-previews.yml` | `workflow_dispatch` | per-PR package previews |
| `qa-deploy.yml`, `qa-stop-on-merge.yml`, `dev-deploy.yml` | dispatch / PR closed | 4 QA slots on Dokploy |
| `release-prepare.yml`, `release.yml` | dispatch | two-stage release; every reversible step runs before `npm publish` |
| `community-labels.yml`, `skills-tiers-lint.yml` | issue_comment / PR on `.ai/skills/**` | minor |
| CodeQL (default setup) | push + PR | appears as `dynamic/github-code-scanning/codeql` |

## 2. `ci.yml` job graph and measured wall time

```
prepare (4-6 min — builds the Next.js app ONCE, computes scope as job outputs)
   |- audit-scope -> audit           (audit skipped when no manifest changed)
   |- lint, ds-lint                  (ds-lint posts a sticky PR comment with delta vs base)
   |- test                           (13-18 min: typecheck + jest + ~8 unfiltered guards)
   |- documents-multi-instance       (ubuntu-latest, Redis/PG sidecars)
   |- ephemeral-integration          <- PLAYWRIGHT
   |     push: 15 shards x 20-34 min
   |     PR:   1 runner, affected modules only (~15 min) OR skipped entirely
   |- merge-coverage  (see finding 1)
   `- docker-build    (see finding 3)
```

`prepare` uploads two artifacts — `build-artifacts` (packages `dist/` + generated) and `app-build` (the tarred `.mercato/next/`) — so no shard rebuilds the app. The stated saving is ~96 s x 15 = ~24 min.

`test` deliberately carries steps that run **unfiltered**, outside the `turbo --filter=[origin/base]...` scope: `yarn workspace create-mercato-app test` (template parity, #3779) and `yarn test:repo-wide-guards` (#4534, #4527). The comment on the latter is worth copying verbatim as a rule: *"The turbo filter selects packages, not paths, so a PR touching only `scripts/` selects no package and those audits never run — the violation then lands on develop and the post-merge unfiltered `yarn test` goes red for everyone."*

## 3. Test inventory (counted statically at `852d0f7f`, `create-app/template` excluded)

| Layer | Files | Cases |
| --- | --- | --- |
| Jest (unit/component) | 3 568 | ~30 400 `it(` / `test(` |
| Playwright `__integration__` | 1 334 `.spec.ts` | **2 687** `test(`, of which **219 are `test.skip(`** |

The "3000+ tests" figure is almost certainly the Playwright suite. Specs live in 68 `<package>/src/modules/<name>/__integration__/` directories; `.ai/qa/tests/` holds only the shared config plus a `__no_tests__/affected-modules-empty.spec.ts` guard used when the affected-module filter selects nothing.

Note against their own rule in `.ai/qa/AGENTS.md` ("Never leave broken tests; fix them or use `test.skip()` with a clear reason"): 219 skipped cases is 8% of the suite, and nothing in CI reports that number.

Reproduce:

```bash
git ls-files | grep '__integration__.*\.spec\.ts$' | grep -v 'create-app/template' > /tmp/specs.txt
wc -l < /tmp/specs.txt
tr '\n' '\0' < /tmp/specs.txt | xargs -0 grep -ohE '^[[:space:]]*test(\.(skip|only|fixme))?\(' | wc -l
tr '\n' '\0' < /tmp/specs.txt | xargs -0 grep -ohE 'test\.skip\(' | wc -l
```

## 4. How the scope is computed

One bash step in `prepare` (`id: integration-scope`) writes three outputs — `skip`, `modules`, `shard_matrix`:

1. **push** -> always the full 15 shards.
2. **PR touching `FULL_SUITE_PATTERN`** -> full 15 shards. The pattern is
   `^packages/shared/|^packages/ui/|^packages/events/|^packages/queue/|^packages/cache/|^packages/search/|^packages/onboarding/|^packages/webhooks/|^packages/core/src/lib/|^packages/enterprise/src/lib/|^packages/cli/src/lib/testing/|^apps/mercato/src/(app|lib|components|layout\.|page\.)`
3. **PR touching `*/src/modules/<x>/`** -> one runner with `OM_INTEGRATION_MODULES=<x>`; `playwright.config.ts` filters by each spec's `moduleName` and `requiredModules`.
4. **anything else** -> `skip=true`: integration **and** `docker-build` are both skipped.

Measured over 30 completed PR runs: **15 full-suite / 5 affected-only / 10 skipped**. One PR in three merges with no e2e evidence from CI.

```bash
gh api "repos/open-mercato/open-mercato/actions/workflows/ci.yml/runs?per_page=100&event=pull_request&status=completed" \
  --jq '.workflow_runs[] | select(.conclusion=="success" or .conclusion=="failure") | .id' | head -30 |
while read RID; do
  gh api "repos/open-mercato/open-mercato/actions/runs/$RID/jobs?per_page=60" \
    --jq '[.jobs[]|select(.name|startswith("ephemeral-integration"))] |
          if length==0 then "ABSENT" elif .[0].conclusion=="skipped" then "SKIPPED" else "RAN(\(length))" end'
done | sort | uniq -c
```

## 5. Findings

### 1. `merge-coverage` has not run since 2026-08-26

Across 60 scanned push runs: 19 `skipped`, 23 `cancelled`, **1 `success`** — run `32967693766`, 2026-08-26. The job's own comment calls it *"the final gate — runs after all integration shards AND the test job complete. Ensures both typecheck/units and integration must pass before reporting green"*. It does not exist in practice, and `scripts/merge-coverage.mjs` is dead code.

**Cause, established by correlation.** In the one successful run `audit` concluded `success`; in every skipped run `audit` concluded `skipped` (checked on 14 consecutive push runs, no counterexample). `test` and `documents-multi-instance` both carry

```yaml
if: |
  always() && needs.prepare.result == 'success' && needs.audit-scope.result == 'success' &&
  (needs.audit.result == 'success' || needs.audit.result == 'skipped') && needs.lint.result == 'success'
```

so they survive a skipped `audit`. `merge-coverage` carries only `if: needs.prepare.outputs.shard_matrix != '["none"]'` — no `always()` — and inherits the skip transitively. The workaround was applied to two jobs of the same family and forgotten in the third.

This is the AGENTS.md lesson *"enumerate the transitions out of every state you add or keep"* in another shape: `audit` became conditionally-skipped and every dependent needed an `always()` guard; one dependent never got one, and the failure is silent because a skipped job reports green.

```bash
gh api "repos/open-mercato/open-mercato/actions/runs/35235580944/jobs?per_page=60" \
  --jq '.jobs[]|select(.name=="audit" or .name=="merge-coverage")|"\(.name) \(.conclusion)"'
# audit skipped / merge-coverage skipped
gh api "repos/open-mercato/open-mercato/actions/runs/32967693766/jobs?per_page=60" \
  --jq '.jobs[]|select(.name=="audit" or .name=="merge-coverage")|"\(.name) \(.conclusion)"'
# audit success / merge-coverage success
```

### 2. The scope blind spot contains the integration suite's own fixtures

552 source files (8% of 6 837 non-test `.ts`/`.tsx` under `packages/` + `apps/`) match neither `FULL_SUITE_PATTERN` nor `*/src/modules/`, so a PR touching only them skips e2e entirely:

| Path | Files | Why it matters |
| --- | --- | --- |
| `packages/core/src/helpers/integration/` | 36 | **the shared helpers and fixtures every spec imports** |
| `packages/core/src/testing/integration/` | 8 | same |
| `packages/cli/src/lib/generators/` | 44 | module generators |
| `packages/ai-assistant/src/frontend/` | 34 | React components |

The irony is documented inside the workflow itself. `packages/cli/src/lib/testing/` was added to `FULL_SUITE_PATTERN` with the comment: *"A change there matches no `src/modules/` path, so without this entry the job that would exercise it is the one job it can never trigger."* They fixed one half of the harness (the ephemeral runner) and left the other half (the fixtures in `core/src/helpers/integration` and `core/src/testing`) uncovered.

```bash
git ls-files | grep -E '^(packages|apps)/.*\.(ts|tsx)$' | grep -v '__tests__\|\.test\.\|__integration__' > /tmp/src.txt
FULL='^packages/shared/|^packages/ui/|^packages/events/|^packages/queue/|^packages/cache/|^packages/search/|^packages/onboarding/|^packages/webhooks/|^packages/core/src/lib/|^packages/enterprise/src/lib/|^packages/cli/src/lib/testing/|^apps/mercato/src/(app|lib|components|layout\.|page\.)'
grep -vE "$FULL" /tmp/src.txt | grep -vP '(?:packages/[^/]+|apps/[^/]+)/src/modules/' | cut -d/ -f1-4 | sort | uniq -c | sort -rn
```

### 3. A Docker change disables the Docker build job — and it already happened

`docker-build` is gated on `needs.prepare.outputs.skip_integration != 'true'`, with the comment *"those changes do not affect app source or Dockerfiles"*. That is false: `Dockerfile`, `docker/**` and `docker-compose*.yml` match no module path, so they produce `skip=true`.

**PR #6191** ("fix(docker): move fullapp stack to a fresh bridge network", `risk-medium`, `priority-high`) changed exactly six compose files:

```
docker-compose.fullapp.dev.yml       starters/docker/compose.fullapp.dev.yml
docker-compose.fullapp.traefik.yml   starters/docker/compose.fullapp.traefik.yml
docker-compose.fullapp.yml           starters/docker/compose.fullapp.yml
```

Its check runs: `ephemeral-integration` **skipped**, `docker-build` **skipped**. The one job that could have validated a Docker networking change was switched off by a rule written for docs-only PRs.

Root shape: the `skip_integration` output is **overloaded**. It means "no module code changed", and `docker-build` reuses it as a proxy for "nothing Docker-relevant changed". Those are different questions, and a Docker-only PR is exactly where they diverge. `docker-build` needs its own path predicate.

### 4. The QA gate is documentation-only, and the same PR bypassed it

`.ai/docs/pr-workflow.md` states the hard rule: *"a PR carrying `needs-qa` MUST NOT be merged unless it also carries `qa-approved`"*. Timeline of #6191:

| Time (UTC) | Event |
| --- | --- |
| 12:58:54 | PR opened |
| 12:58:55 | labeled `bug`, `review`, `needs-qa`, `priority-high`, `risk-medium` |
| **13:01:02** | **merged by a human**, labels still `needs-qa`, no `qa-approved` |
| 13:05:07 | the `test` job finishes — four minutes AFTER the merge |

So a `risk-medium`, `priority-high` bug fix landed with no unit-test result, no integration result, no Docker build and no QA approval. The rule is respected by the `om-auto-*` skills and enforced by nothing — no branch protection, no required check, no merge-gate workflow.

```bash
gh api "repos/open-mercato/open-mercato/issues/6191/timeline?per_page=100" \
  --jq '.[] | select(.event=="labeled" or .event=="merged") | "\(.created_at) \(.event) \(.label.name // "")"'
gh api "repos/open-mercato/open-mercato/commits/eb1247dcfbe1c3642f932936cb47ab5451bdf3f2/check-runs" \
  --jq '.check_runs[] | "\(.name)\t\(.conclusion)\t\(.completed_at)"'
```

### 5. Fork PRs get no CI signal until a maintainer clicks

In the last 100 workflow runs, 20 `CI for Develop&Main` and 20 `Mutation tests` runs sit in `action_required`. On a public repo with 1109 open issues that is a real bottleneck for outside contributions — and it compounds with the self-hosted runner choice (finding 6): fork PRs reach neither the secrets nor the Blacksmith layer cache, which is why `docker-build` additionally requires `github.event.pull_request.head.repo.full_name == github.repository`.

## 6. Runners: Blacksmith is self-hosted (managed, third-party)

`blacksmith-4vcpu-ubuntu-2404` is not a GitHub-hosted label. It is a managed third-party runner fleet (useblacksmith.com) that registers with the repository as a self-hosted runner group. Two jobs from the same run:

```
prepare                    labels: ["blacksmith-4vcpu-ubuntu-2404"]
                           runner_group_name: "blacksmith runners 01kzwwgen1yjtmaca9nmg188dv"
                           runner_name: "blacksmith-01m2qx6pssh2xgp1wj597p2che-4vcpu"

documents-multi-instance   labels: ["ubuntu-latest"]
                           runner_group_name: "GitHub Actions"
                           runner_name: "GitHub Actions 1000119531"
```

They paid for this with a regression, and documented it in `snapshot.yml:31-39`:

> GitHub-hosted on purpose — do NOT move this job to a Blacksmith runner. `scripts/publish-packages.sh` publishes with `npm publish --provenance`, and npm's sigstore verification rejects every other runner class: *422 Unprocessable Entity — Error verifying sigstore provenance bundle: Unsupported GitHub Actions runner environment: "self-hosted"*. Blacksmith runners register as `self-hosted`, so **this job published nothing between #5244 and #5292**.

The guard is `scripts/__tests__/npm-provenance-runners.test.mjs`, which pins publishing jobs to `ubuntu-latest` and notes that *"third-party runner fleets (Blacksmith, Namespace, Warpbuild, self-hosted metal) all register as `self-hosted`"*.

The split is deliberate:

| Runner | Jobs | Reason |
| --- | --- | --- |
| Blacksmith (self-hosted) | `prepare`, `test`, `lint`, `ds-lint`, `audit*`, the 15 `ephemeral-integration` shards, `merge-coverage`, `docker-build` | cost and throughput — 15 shards x ~25 min is ~6 h of runner minutes per push |
| GitHub-hosted `ubuntu-latest` | `documents-multi-instance`, `snapshot`, `release`, `npm-snapshot-preview` | Docker service containers; sigstore provenance |

## 7. What the agent actually does

- The agent's gate is `validation.commands` in `.ai/agentic.config.json`: `build:packages`, `generate`, `build:packages`, `i18n:check-sync`, `i18n:check-usage`, `typecheck`, `test`, `build:app`. **`test:integration` is not in it** — Playwright is not part of the agent's gate.
- Separate skills run it conditionally: `om-auto-create-pr-loop` and `om-auto-continue-pr-loop` define the "spec-completion gate" as `yarn test:integration` plus `yarn test:create-app:integration` when template-synced surfaces changed. `om-smart-test` selects affected tests — Jest via `--findRelatedTests`, Playwright via module-name matching against `meta.ts` — and caches the plan in `.test-cache.json`, invalidated by `git merge-base --is-ancestor` so a rebase cannot revive a stale plan.
- The agent reports into the PR **body**, as a `## Test plan` section. Example from #6177: *"`yarn jest --config packages/core/jest.config.cjs --testPathPatterns 'page\.doubleSave\.test'` — 2/2 tests pass. Scoped typecheck for `@open-mercato/core` — clean."* Prose in the description, not a check run — and in that instance with no Playwright at all.
- Environment handling is the mature part: `om-prepare-test-env` owns boot/reuse/locking and writes a shared descriptor at `.ai/qa/test-env.json` (baseUrl, credentials, Playwright config, reuse TTL, owner lock); `om-integration-tests` only *attaches* to it.

## 8. Takeaways for cezar / planned.travel / money-tracker.online

**Worth borrowing**

- One `prepare` job that builds the app **once** and publishes the scope decision as job outputs, so shards start the moment the build lands rather than after typecheck. planned.travel's `scope` job only answers "docs-only"; this is the fuller version.
- 15-way sharding with `fail-fast: false`, plus a Playwright browser cache keyed on the exact version (`playwright-chromium-${{ runner.os }}-v1.50.0`).
- `ds-lint`'s sticky PR comment with a **delta against the base branch** (it checks out the base into a worktree and diffs the two ESLint JSON reports). Strictly better than a pass/fail lint check, and it is `continue-on-error` on the base half so an old base degrades to "delta n/a" instead of failing.
- A scheduled twin for any diff-triggered scan (`audit.yml`), with the comment explaining why it cannot live in the main workflow.
- The `test` job's unfiltered-guards pattern: when the test selector is package-based but some tests are repo-wide audits, list them in ONE place (`scripts/repo-wide-guards.mjs`) and run them unconditionally. Their comment explicitly forbids re-listing them in the workflow, because the duplicate list went stale (#4770).

**Worth avoiding — same class of error as AGENTS.md § "Changing a mechanism that already works"**

- An overloaded scope output (`skip_integration` doing duty as "nothing Docker-relevant changed").
- `always()` applied to two of three sibling jobs — a skipped ancestor silently reports green.
- A hard merge rule that exists only in documentation. If `needs-qa` must block a merge, it needs a required check; cezar's planned `merge-gate.yml` port (spec `.ai/specs/2026-09-17-afk-intake-bridge.md`, P6) is the right shape for it.

## Related

- `.ai/specs/2026-09-17-afk-intake-bridge.md` — P6 (cezar CI on `design4pro`, `merge-gate.yml` adoption) is the work this analysis informs.
- `AGENTS.md` § Changing a mechanism that already works — findings 1 and 3 are textbook instances.
