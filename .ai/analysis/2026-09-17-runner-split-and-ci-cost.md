# Runner split and CI cost — planned.travel and money-tracker.online

Measured 2026-09-17 over the 30 days to that date, against the shared self-hosted
pool (4 CI slots + 2 agent slots, one local macOS host) and GitHub's 3,000
included minutes on the Team plan.

## Answer

The self-hosted pool keeps everything except shipping. Verified in the
organisation's billing page on 2026-09-17: **GitHub Team, 3,000 Actions minutes
included, 0 used**. That is ~7% of this fleet's demand - planned.travel's `unit
tests` job alone bills ~3,878 min/month, and a GitHub-hosted 2-core runner costs
roughly 2.2x what these containers do for the same work - so it buys one thing,
not a share.

It buys the deploys. `deploy-*`, `deploy.yml` and `rollback.yml` in both
repositories now run GitHub-hosted (§ 3), for ~1,900 of the 3,000 minutes at $0.

The lever that actually matters is inside the pool, and the measurement found one
that dwarfs everything else: a **defect in money-tracker's toolchain action** was
costing ~105 s in every job of every workflow - about 7,000 min/month, the single
largest line in the fleet. That is fixed (§ 2). Nothing else measured was worth
its cost (§ 4).

## 1. Measured job cost (30 days to 2026-09-17)

Job wall time is `completed_at - started_at` sampled over the 40 most recent CI
runs per repo, scaled by that workflow's run count.

| Repo | Job | runs/mo | avg | max | min/mo |
| --- | --- | ---: | ---: | ---: | ---: |
| planned.travel | `e2e · critical journeys` (2 shards) | 1,047 legs | 635 s | 1,225 s | **11,081** |
| planned.travel | `unit tests` | 773 | 301 s | 922 s | **3,878** |
| planned.travel | `lint · typecheck · build` | 773 | 161 s | 568 s | 2,074 |
| planned.travel | `e2e · merged report` | 548 | 79 s | 616 s | 722 |
| planned.travel | `change scope` | 499 | 16 s | 58 s | 133 |
| money-tracker | `e2e · mobile-safari` (2 shards) | 705 legs | 406 s | 1,223 s | **4,771** |
| money-tracker | `axe · WCAG 2.2 AA gate` | 738 | ~400 s | — | **4,900** |
| money-tracker | `e2e · chromium` | 352 | 563 s | 1,226 s | 3,303 |
| money-tracker | `unit tests · coverage` | 519 | 230 s | 984 s | 1,990 |
| money-tracker | `generated · typecheck · lint · build` | 519 | 185 s | 647 s | 1,600 |
| money-tracker | `e2e · merged report` | 352 | 96 s | 157 s | 563 |
| money-tracker | `verdict` | 148 | 15 s | 53 s | 37 |

CI run counts by event: planned.travel 709 `pull_request` / 288 `push` / 0
`merge_group`; money-tracker 547 / 191 / 2.

## 2. The toolchain defect

Step-level timings put `Set up the toolchain` at **134 s** in money-tracker and
**26-35 s** in planned.travel — same pool, same runner image, same stack. The
log of job 105157932544 explains the whole gap:

```
09:58:04  Set up Node          cache: pnpm
09:58:04  Found in cache @ /opt/hostedtoolcache/node/24.21.0/arm64   ← 0.4 s
09:58:06  pnpm store path --silent
          /home/runner/setup-pnpm/node_modules/.bin/store/v10        ← inside the container
09:58:07  Cache hit  node-cache-Linux-arm64-pnpm-96bef680…
09:58:08  Received 0 of 330795174 (0.0%)                             ← 330 MB at ~7 MB/s
10:01:22  Install dependencies                                       ← 198 s later
```

Two guards that planned.travel has carried since the pool was built were absent
from money-tracker's copy of `.github/actions/setup/action.yml`:

- **`cache: pnpm` was unconditional.** On the self-hosted pool it restored a
  330 MB tarball over the network on every job, for a store that is thrown away
  with the container. planned.travel gates it on
  `runner.environment == 'github-hosted'`.
- **The persistent store was never used.** The pool mounts a `gha-pnpm-store`
  volume at `$HOME/.local/share/pnpm/store` (agent-kit `host/runner/pool.sh`);
  pnpm's default store is `$PNPM_HOME/store`, which action-setup puts inside the
  container. planned.travel exports `npm_config_store_dir` when that path is a
  writable mount.

Both were ported verbatim. Expected effect, using planned.travel's measured
26-35 s as the target: ~105 s off roughly 4,000 jobs/month across `ci.yml`,
`a11y.yml`, `merge-gate.yml` and the deploy workflows — **~7,000 min/month**.

It also disproportionately hits the two heaviest consumers, because both embed
the same action inside a composite one:

| Step | before | of which toolchain | after (projected) |
| --- | ---: | ---: | ---: |
| `axe` → `Prepare the browser-test environment` | 271 s | ~134 s | ~140 s |
| `e2e · chromium` → same | 179 s | ~134 s | ~50 s |

## 3. The split

Deploys and rollback run on GitHub-hosted runners behind `vars.RUNNER_DEPLOY`,
which is deliberately unset and defaults to `["ubuntu-latest"]`.

| Workflow | repo | jobs/mo | self-hosted min/mo |
| --- | --- | ---: | ---: |
| `deploy-staging.yml` | money-tracker | 111 | 278 |
| `deploy-production.yml` | money-tracker | 56 | 220 |
| `deploy-staging.yml` | planned.travel | 174 | 296 |
| `deploy.yml` (production) | planned.travel | 25 | 52 |
| `rollback.yml` | planned.travel | rare | ~0 |
| | | | **~850** |

~1,900 of the 3,000 included minutes at ~2.2x, leaving ~1,100 for failover. The
argument is not primarily budgetary:

- A deploy must not queue behind an agent's twenty-minute browser suite. On a
  4-slot pool shared by two repositories, the slot it waits for is how long
  production stays on the old bundle.
- `deploy-staging.yml` already documented that `vars.RUNNER_CI` was "the recovery
  path for shipping … the switch has to work when that machine does not" - which
  made recovery a variable somebody has to remember to set, under exactly the
  conditions that make it hard to remember. Deploying there by default retires
  the lever.

**This is plan-dependent, and it was wrong once.** The API reported `plan: free`
mid-session (during a move off Enterprise Cloud), the split was reverted on a
2,000-minute allowance where ~1,900 min is 95% of the budget, and it was
re-applied once the billing page confirmed Team. Each workflow's comment carries
the premise and the instruction to set `RUNNER_DEPLOY` back to the pool on a
downgrade. Everything else stays self-hosted: the browser suites need the ARM64
image built FROM `mcr.microsoft.com/playwright:v1.62.1-noble`, and
`verify`/`test` at 773+519 runs/month fit in no allowance GitHub sells here.

## 3a. Runner pool state

All six runners (`gha-ci-1..4`, `gha-agent-1..2`) are registered into the custom
runner group **`local-mac`**, and `Default` holds none. GitHub documents custom
organisation runner groups as a **Team** feature ("Organization owners using the
GitHub Team plan can create additional organization-level runner groups"), so on
Team this arrangement is supported outright.

It also survives a downgrade, which was measured rather than assumed: while the
API briefly reported `plan: free`, a dispatched CI run (35271605265) was picked up
by all four CI runners within 50 s, and the pool's `--ephemeral` re-registration
afterwards put six runners back into `local-mac` with fresh ids. GitHub blocks
*creating* a group below Team, not using one that exists.

Worth knowing anyway, because it is a single point of failure that would present
as "no CI, no obvious cause": `host/runner/entrypoint.sh` passes
`--runnergroup "$RUNNER_GROUP"` (default `local-mac`). If GitHub ever enforces the
restriction at registration time the whole pool stops coming back. The mitigation
needs no image rebuild - `pool.sh` already reads `GHA_RUNNER_GROUP`, so
`GHA_RUNNER_GROUP=Default` and a pool restart moves the fleet to the
always-supported group. The cost is that `Default` is visible to every repository
in the organisation rather than the three `local-mac` names, and narrowing its
visibility is itself a Team feature. `Default` does carry
`allows_public_repositories: false`, which is the guard that matters: cezar is
public, and fork pull requests must never reach these runners.

## 4. Rejected

**A shared `prepare` job that builds the app once.** money-tracker builds per e2e
leg (`E2E_BUILD=1`, which makes it a *different* build from `verify`'s, so only
the 3 legs could share it). Measured, `Build` is **31 s**. Sharing it saves
31 s x 2 redundant legs = 62 s, against ~20 s of artifact round-trip (upload once,
download three times, at the 7 MB/s this pool gets to GitHub), one extra job on a
4-slot pool, and a serialisation point where three legs that start immediately
today would instead wait. Net ~246 min/month for a new failure mode and worse
latency. The build was never the cost — `Set up the toolchain` was, at 4.3x it.

**More, smaller shards.** The pool has 4 CI slots for both repositories; today
money-tracker takes 3 e2e legs and planned.travel 2, so additional shards queue
rather than parallelise. money-tracker's own workflow already records a measured
rejection of a third mobile-safari leg ("a third leg predicts 458s / 274s / 253s
of suite time - the leg that matters moves 28s, for a whole extra runner"). More
shards are the right lever only for legs placed on GitHub-hosted, and those do
not fit in 3,000 minutes.

**Porting money-tracker's `verdict` short-circuit to planned.travel.** Sampled
over 30 push runs it reduced the job count in only 3 — ~10%. A squash merge onto
a base that has moved produces a tree no earlier run judged, which is most of
them. ~29 runs/month saved in planned.travel; not worth the `actions: read` scope
and a second copy of `verified-tree.mjs`.

## 5. Left open

- **mobile-safari shard imbalance**: 354 s against 185 s. `--shard` divides by
  test count, not duration, and Playwright 1.62 offers nothing duration-aware.
  Rebalancing means moving specs between files.
- **`merge_group` is effectively unused**: 0 runs in planned.travel and 2 in
  money-tracker over 30 days, while both repositories require
  `e2e · merged report` as a status check and only money-tracker's `develop`
  ruleset carries a `merge_queue` rule. In money-tracker the e2e legs are skipped
  on `pull_request` (ADR 0020 moved them to the queue), a skipped job satisfies a
  required check, and the queue then almost never runs — so the journeys are in
  practice a *post-merge* `push` gate. Worth deciding deliberately.
- **`a11y.yml` duplicates `ci.yml`'s whole environment** on the same commit, in a
  separate workflow, and therefore on a separate runner: two builds, two
  migrations, two seeds per pull request. Merging `axe` into `ci.yml` as a matrix
  leg would not share the environment either, but would at least let `scope`-style
  gating apply to it; today it has none.

## Related

- `.ai/analysis/2026-09-17-open-mercato-ci.md` — the same questions asked of a
  third repository, which runs everything on Blacksmith.
- money-tracker ADR 0016 (journeys run with no label), ADR 0020 (journeys moved
  to the merge queue), ADR 0021 (unit shards retired on the self-hosted pool).
