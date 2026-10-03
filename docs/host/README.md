# Host layer

Everything under `host/` is applied to a machine, not rendered into a repository. Nothing here is
generated and nothing verifies it: a green CI run in this repository means nothing about a host
that has not been touched. The `__PLACEHOLDER__` substitutions below are the whole mechanism.

Three services live here:

```
host/launchd/dev.cezar.cockpit.plist    the cockpit: one `cezar serve` per host (LaunchAgent)
host/runner/                            the self-hosted GitHub Actions runner pool (systemd, VPS)
host/reconciler/                        the reconciler: one cron tick that repairs and starts unattended tasks
```

The cockpit is one per host and serves every registered project, so host state belongs with the
cockpit's own repository rather than in any application repo. It lived in money-tracker.online
once, where planned.travel could not see it and had no copy of its own; it then lived in
`design4pro/agent-kit`, which has been retired.

Each application repo keeps only its own housekeeping plist.

## The cockpit runs a fork, not npx

The cockpit runs `design4pro/cezar`, a fork of `open-mercato/cezar`, from a checkout on the host.
Its `design4pro` branch is an upstream release tag plus one commit per fix this pipeline needs and
upstream has not shipped:

- the automations poller filters the timeline before validating it (cherry-pick of upstream PR
  #916, open-mercato/cezar#914) - without it **Re-groom on request**,
  **Fix issues on the autofix label** and **Write a spec for feature issues** never fire;
- `filters.includePullRequests` polls label events on pull requests -
  **Resolve blocking review threads** never fires without it;
- `CEZ_SKILLS_AUTO_UPDATE=0` skips the `npx skills check` too, which otherwise replaces the vendored
  `.claude/skills/om-*` with symlinks into an untracked `.agents/` at service start;
- a worktree fork that lost the shared `.git/config` lock to a concurrent run is retried;
- a truncated label poll that did not move its cursor widens its budget (planned.travel#351), and
  records the cursor it gave up at as `widenExhaustedAt`.

Upstream is not a fallback, whether through `npx` or `npm i -g`: it runs without every fix above and
reports nothing, so the first symptom is pull requests sitting with unresolved threads. That is why
`housekeeping.sh`'s headless path in each application repo refuses to start when `cezar` is not on
PATH rather than reaching for npx - that path runs exactly when the cockpit is already unreachable.

Cutover, or setting up a new host:

```sh
git clone git@github.com:design4pro/cezar.git ~/dev/cloudflare/cezar
cd ~/dev/cloudflare/cezar
git remote add upstream git@github.com:open-mercato/cezar.git
git switch design4pro
npm ci
npm run install-as-command   # npm link: `command -v cezar` keeps its path, the link follows the checkout

sed -e "s|__CEZAR__|$(command -v cezar)|" -e "s|__HOME__|$HOME|" \
    -e "s|__REPO_ROOT__|$PWD|" -e "s|__PATH__|<PATH with node, claude, git, gh, pnpm>|" \
    host/launchd/dev.cezar.cockpit.plist > ~/Library/LaunchAgents/dev.cezar.cockpit.plist
launchctl bootout gui/$(id -u)/dev.cezar.cockpit
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.cezar.cockpit.plist
```

`__REPO_ROOT__` is the boot repo - this checkout serves as its own, and the projects it then hosts
come from the registry at `~/.cezar/config.json`, not from that path.

The rendered plist carries every variable the cockpit needs - `CEZ_AUTOMATIONS=1`,
`CEZ_AUTONOMOUS_DEFAULT=0`, `CEZ_SKILLS_AUTO_UPDATE=0` and `GH_CONFIG_DIR` - and nothing inserts
them into an installed one, so re-render a plist rather than editing one in place. Since 0.11.0
automations are on unless `CEZ_AUTOMATIONS=0`, so the explicit `1` changes nothing.

`GH_CONFIG_DIR` is a path, not a token: it points at the `design4pro-agent` gh login, so `gh` and
`git push` inside a run act as the bot while the developer's own `gh` config is untouched.

The plist deliberately does not go through `bash -lc`. A login shell sources `~/.profile`, and the
cockpit forwards `GH_TOKEN`, `ANTHROPIC_*`, `CLAUDE_*` and `CEZ_*` into every agent run - so a key
exported there would become a key in every run.

Restart only while the cockpit has no active runs: a run whose cockpit disappears mid-flight is not
something the protocol recovers from.

## Taking an upstream release

```sh
cd ~/dev/cloudflare/cezar
git fetch upstream --tags
git rebase --onto vX.Y.Z <old-tag> design4pro   # drop any commit upstream has merged
npm ci && npm run build
LC_ALL=C npx vitest run --project server   # the cockpit's own code
git push --force-with-lease origin design4pro
```

The server project is the gate, run with git in English: several of its tests match git's own
messages, and a localized git fails them. The web project needs
`NODE_OPTIONS=--localstorage-file=<file>` on Node 26, and stock v0.11.0 fails eight of its tests
even then - so compare a red web run against the tag before blaming a fork commit.

Then restart the cockpit with the same `bootout` / `bootstrap` pair, once it is idle.
`npm run install-as-command` is needed once per host, because the link follows the checkout; a
rebuild is needed after every change to it, because what the link serves is the build.

`~/.cezar/config.json` carries no per-project `maxParallel`. The global `resources.maxParallel` is
the one knob; a per-project 16 beside a global 4 is not a decision anyone made, it is a value left
behind, and it lets one repository start four times what the host was sized for.

## The runner pool

Every GitHub Actions job of `planned.travel` and `money-tracker.online` runs on one machine: an OVH
VPS with 8 KVM vCPUs (Intel Haswell), 22 GB of memory and 190 GB of disk. There are no other
self-hosted runners and no third-party runner services; GitHub-hosted runners are only the kill
switch below.

```
host/runner/Dockerfile                the runner image: Playwright's own base, plus the runner
host/runner/entrypoint.sh             register ephemerally, take one job, deregister
host/runner/pool.sh                   reconcile the pool to its declared size; safe to run at any time
host/runner/gha-runner-pool.service   systemd keeps pool.sh alive
host/runner/pool.env.example          every setting pool.sh reads, with the VPS values
```

**This repository does not use the pool.** Every job in its own workflows runs on `ubuntu-latest`.
The pool lives here because host state belongs with the cockpit's repository. See
`docs/adr/0007-the-host-layer-lives-here.md`.

### How a slot works

systemd keeps `pool.sh` alive. Every `GHA_RUNNER_INTERVAL` seconds it walks the declared slots: a
running container is left alone (only its restart policy is set to `no`), an exited one is removed
and replaced. Docker restart reuses a writable layer; it is never isolation. Each replacement uses
the immutable image ID resolved from `GHA_RUNNER_IMAGE` for that cycle and runs with
`--restart=no`, so every job starts from a clean container and everything it wrote disappears with
it.

The organisation token stays in `GHA_RUNNER_TOKEN_FILE`; only `pool.sh` calls GitHub's
registration-token endpoint. A container receives the short-lived registration token and unsets it
before starting the runner. No organisation token, host home, Docker socket or credential file is
mounted. The registration token stays visible in Docker metadata until the container is removed, so
Docker access remains a trusted host capability. `--ephemeral` deregisters a runner after its job;
`--replace` repairs a registration after a crash. A failed registration, launch, daemon connection or
removal retries next cycle.

### The two pools

| Pool | Labels | Slots | CPU / memory | Mounts | Runs |
| --- | --- | --- | --- | --- | --- |
| ci | `self-hosted,linux,X64,ci` | 2 | 4 / 8g | `/srv/ci-artifacts` → `/ci-artifacts` | build, unit, e2e, a11y, deploys, rollback, promotion |
| agent | `self-hosted,linux,X64,agent` | 1 | 2 / 4g | none | sentry-triage |

The sizes are measured, not guessed. One of these vCPUs does about a third of the work of an
Apple-silicon core: three CI slots of three CPUs cut planned.travel's e2e shards off at their 900 s
budget, two slots of four finish them in 10-13 min. agent oversubscribes the eight cores on
purpose; it is idle or network-bound almost all of the time.

A third pool, `gate` (one slot of 1 CPU / 2g), ran the seconds-long merge-gate, auto-merge and
promotion jobs so they did not queue behind e2e shards. It was retired on 2026-09-25: the merge-gate
and auto-merge workflows were deleted and promotion moved to `ci`. A host whose `pool.env` still
sets `GHA_RUNNER_GATE_*` ignores them; stop and remove an existing `vps-gate-1` and delete its
registration as described below.

The CPU quota also sizes the jobs themselves: Node's `os.availableParallelism()` reports the quota,
so vitest starts that many workers, not one per host core. Swap equal to memory means an over-budget
job is OOM-killed rather than paged. `pool.sh` applies changed ceilings to replacement containers,
never to an active job, and it never removes containers above a lowered count - stop and remove
those by hand once they are idle, and delete their registration
(`gh api -X DELETE orgs/design4pro/actions/runners/<id>`).

### The artifact store

`GHA_RUNNER_ARTIFACTS_DIR` (default `/srv/ci-artifacts`) is mounted into every CI container at
`/ci-artifacts`. `design4pro/.github`'s `artifact-upload` and `artifact-download` actions write
there when it exists, as `/srv/ci-artifacts/<owner>__<repo>/<run_id>/<name>/`, which keeps
Playwright reports and coverage off GitHub's 2 GB Actions storage allowance (exhausted in September
2026: 1488 GB-hours against about 1440). It is the only writable mount, only CI slots get it, and it
holds data, never tools. The directory belongs to the uid the image's `runner` user got.

A root systemd timer, `ci-artifacts-cleanup.timer`, deletes run directories older than 14 days
every night. The artifacts are not listed in the GitHub UI; each upload's step summary names its
path, and `scp` fetches it.

### Setting up the host

The token is a **classic** PAT with the full `admin:org` scope. `manage_runners:org` alone gets 403
from `POST /orgs/{org}/actions/runners/registration-token` (`x-accepted-oauth-scopes: admin:org`).
Give it an expiry and track it: when it lapses, slots stop registering.

```sh
sudo useradd --system --create-home --home-dir /var/lib/gha-pool --groups docker gha-pool
sudo install -d -m 700 -o gha-pool /etc/gha-runner
printf '%s' '<classic PAT with the full admin:org scope>' | sudo tee /etc/gha-runner/token >/dev/null
sudo chown gha-pool /etc/gha-runner/token && sudo chmod 600 /etc/gha-runner/token
sudo install -m 644 host/runner/pool.env.example /etc/gha-runner/pool.env   # then edit

sudo docker build -t gha-runner:local host/runner
sudo install -d -m 750 -o "$(sudo docker run --rm --entrypoint id gha-runner:local -u)" /srv/ci-artifacts

sed -e "s|__POOL_SH__|$PWD/host/runner/pool.sh|" -e "s|__USER__|gha-pool|" \
    host/runner/gha-runner-pool.service | sudo tee /etc/systemd/system/gha-runner-pool.service >/dev/null
sudo systemctl daemon-reload && sudo systemctl enable --now gha-runner-pool
```

`pool.sh` runs from a checkout of this repository on the host (`/opt/cezar`, branch
`design4pro`); `git pull` there and `systemctl restart gha-runner-pool` to roll a change out.

The organisation needs a runner group named `vps`, scoped to exactly the repositories that may use
it, with public repositories disallowed. Without the group every repository in the organisation
could schedule work on this host.

### The kill switch

Every job reads a repository variable with the pool as its default:

```yaml
runs-on: ${{ fromJSON(vars.RUNNER_CI || '["self-hosted","linux","X64","ci"]') }}
```

Setting `RUNNER_CI`, `RUNNER_AGENT` or `RUNNER_DEPLOY` to `["ubuntu-latest"]` moves those jobs to
GitHub-hosted runners without a pull request - the recovery path when the VPS is down. On
GitHub-hosted runners the artifact actions fall back to GitHub storage, so leave the variables unset
again once the host is back.

### Bumping the runner image

The `FROM` tag in `host/runner/Dockerfile` must match the `@playwright/test` version resolved in
both consumer lockfiles. Playwright refuses to launch a browser build whose revision it did not
ship with, and the error names an executable rather than a version, so the failure does not read as
a version skew. Bump Playwright in a repository, bump this tag, rebuild, and the running supervisor
picks the new image ID up as containers finish. Do not start a second supervisor alongside systemd.

### What the image must carry

A workflow written for `ubuntu-latest` is written against that image's preinstalled tooling, and it
never says so. `gh`, `bun`, `unzip`, `zip`, `xz` and `sudo` are simply there. Actions that look
self-contained are not: `oven-sh/setup-bun` downloads a zip and needs `unzip` to open it, and
`review-threads-label.mjs` shells out to `gh`.

Neither failure names what is missing. The bun one reported `bun: command not found` 2299 ms after a
successful download; the other, `spawnSync gh ENOENT` from a script nobody had changed. Both read as
a broken runner rather than a thin image.

Before routing a new workflow onto the pool, list the binaries its steps and its actions invoke and
prove them present in the image, offline so that nothing is quietly downloaded during the check:

```sh
docker run --rm --network none gha-runner:local \
  bash -lc 'for t in node pnpm gh unzip zip xz git jq curl; do command -v "$t" || echo "MISSING $t"; done'
```

### Rolling out a change

1. Run the repository validation gate and `bash host/runner/test-isolation.sh` on a Docker host.
2. Build the reviewed image and record its `docker image inspect` ID.
3. Restart only the supervisor (`systemctl restart gha-runner-pool`); never stop running job
   containers. Existing containers finish on their original image and mounts.
4. Verify replacements use the recorded ID and `RestartPolicy.Name=no`, and that each pool accepts
   and completes a job.

A host or daemon restart can fail an in-flight job; the supervisor recovers slots, not job progress.
If a full drain is required, first move job routing to GitHub-hosted runners with the kill switch
and confirm no busy runners in the organisation API before removing idle containers. Restore
routing only after new registrations and a canary job succeed.

## The reconciler

`host/reconciler/reconcile.mjs` is the one process that starts unattended work (ADR 0009). It is a
Node script with no dependencies and no daemon: cron runs one **tick** every ten minutes, the tick
reads the cockpit, each managed repository and GitHub, acts, and exits. Nothing is held between
ticks except a small state file, and the engine is untouched - everything it does is an HTTP route
the cockpit already serves, a `git` call, or a `gh api` REST call.

```
node host/reconciler/reconcile.mjs --project <id>=<path> [--project ...] [--dry-run] [--max-launch N]
```

- `--project <id>=<path>`: a managed project, by its cockpit id and its checkout. Repeat it; the
  order is the priority, so the first project gets the free slots first.
- `--dry-run`: decide and print one line per decision. It reads everything and changes nothing: no
  merge, no POST to the cockpit, no write to GitHub, no state file. The digest is printed, not
  published.
- `--max-launch N`: start at most N runs this tick, repairs included.
- `CEZ_API`: the cockpit's address (default `http://127.0.0.1:4321`), the same variable the repos'
  `housekeeping.sh` reads. `GH_CONFIG_DIR` on the cron line makes `gh` act as another GitHub login.
- An unknown argument exits 2 with the usage text, so a typo on the cron line fails loudly.

### Installing it

Under `flock`, so a slow tick never overlaps the next. The cron needs no `CRON_TZ` and no
Warsaw-hour guard like the housekeeping lines: the digest does its own Europe/Warsaw arithmetic.

```cron
*/10 * * * * mkdir -p $HOME/.cache/cez && flock -n $HOME/.cache/cez/reconcile.lock node /home/ubuntu/dev/cezar/host/reconciler/reconcile.mjs --project planned-travel=/home/ubuntu/dev/planned.travel --project money-tracker-online=/home/ubuntu/dev/money-tracker.online >> $HOME/.cache/cez/reconcile.log 2>&1
```

Run it once with `--dry-run` first and read what it says. **To stop it, remove the cron line.** There
is nothing else to switch off: no automation, no service, no label.

### What one tick does

A tick first asks the cockpit for its health: if it does not answer, the tick logs that and exits 0,
because a restarting cockpit is not a cron failure. Then it works out the **capacity** and goes
through the managed projects in order.

**Capacity** is the workspace's `maxParallel` minus the runs that hold or wait for a slot, counted
across every project the cockpit has registered, managed or not (`slotsHeld`,
`host/reconciler/reconcile.mjs:72`). It counts them the way the engine's own `busySlots` does
(`packages/cezar/src/workflows/run.ts`): a `running` run and a `queued` run hold a slot; a
`waiting` run holds none (#347); a run that is `running` with `activity: monitoring` holds none up
to `maxMonitoringSessions`; a `review` run has closed its session. A repair, a retried receipt and a
launch each spend one unit; when it is gone the tick says "no free slot" for the rest, or
"--max-launch N reached" when slots are still free but the tick has started its `--max-launch` runs.

**A usage limit stops everything.** If any run in any project is parked on a provider's usage limit
(`isParkedOnUsageLimit`, `reconcile.mjs:87`: a `failed` run with the engine's booked `autoResumeAt`,
or the `Claude AI usage limit reached|<epoch>` envelope while its reset is still ahead), the tick
launches nothing and repairs nothing, because the account has no window and a new run would only
join the queue of failures. The engine resumes that run itself; the next tick after it has done so
carries on. The digest is still published.

Then, per managed project and in this order:

1. **Sync.** Fast-forward the main checkout to `origin/<baseBranch>` and, when
   `docs/agents/cezar-automations.json` changed, re-apply the automations with the repo's own
   `cez-automations.sh`. It leaves the checkout alone when it is not on the base branch or is dirty,
   and when an enabled automation polls within 60 seconds (SDLC.md § Repo automations: a poll reads
   the working tree). A sync that cannot happen is logged and the tick goes on.
2. **Repair.** Only a run that is `failed`, was started unattended (`autonomous`), finished within
   the last 48 hours, is not archived, was not cancelled, and is the newest run of its workflow and
   task (a newer run has taken the work over). The ladder, per run id:
   - attempt 1 and 2: a run with a session is **continued** (`POST /runs/:id/continue`) with a text
     that names the failed step and tells the agent to finish it and every later step itself; attempt
     2 also asks for an independent root-cause specialist sub-agent. A run with no session (its
     bootstrap failed, or the provider lost the session) is **relaunched** as a new run of the same
     workflow and task, and the attempt count follows it to the new run id;
   - after two attempts it **escalates once**: a `🤖 HUMAN-ONLY:` comment on the issue the task
     names (or the one the run recorded) and the `blocked` label, both through `gh api` REST. The
     unblock sweep reads that pair the same way it reads every other hold. A run that names no issue
     is left to the digest;
   - an error repeating cannot help (no `claude` on the PATH, no credentials, an unknown workflow)
     is never retried: it goes to the digest only.
   Launch-error receipts of the last 48 hours are retried once through
   `POST /automation-log/:id/retry`.
3. **Launch.** The target repository answers `node .ai/scripts/backlog-status.mjs --plan` (cwd is the
   project root) with `{"wip":{...},"actions":[{"kind","target","workflow","task"}]}`: at most one
   action per kind, already in priority order (implement, unblock, triage, slice, write-spec).
   The tick starts them in that order, skipping a target an active run already names (`#12` is not
   `#123`), a target whose run failed or was cancelled in the last 48 hours (so a target nobody
   can fix is not relaunched every ten minutes), a target the same workflow finished as `done` in
   the last 6 hours (the agent judged it finished, so repeating it every tick only spends runs), a
   project that already has two runs holding a slot (a monitoring or waiting run holds none), and
   anything past the capacity or `--max-launch`. Starts are 20 seconds apart: two Claude Code
   processes launched in the same second race on the OAuth refresh (PR #50). A repo whose script
   fails or does not know `--plan` launches nothing, and the tick says so.
4. **Digest.** At most once per Warsaw day, on the first tick at or after 07:00 Europe/Warsaw (the
   hour and the date come from `Intl`, so both clock changes are right whatever zone the host runs
   in), the body of the open issue titled exactly `Pipeline status` is replaced: the backlog by
   state, what waits for a person (held issues, pull requests needing QA or a risk decision), the
   unattended runs of the last 24 hours that failed, were escalated or were not retryable, and
   what finished. The issue is created with `do-not-close` when it is missing. It is one issue,
   edited in place, so it never grows a comment thread.

### State

`~/.cache/cez/reconcile-state.json`: repair attempts and escalations per run id, the receipt ids
already retried, the date of the last digest per project. It is written atomically (tmp + rename),
entries older than two weeks are dropped, and a missing or corrupt file degrades to empty. Deleting
it costs nothing worse than a failed run getting its two repairs again and one extra digest.

### What it never does

It never merges a PR, never closes an issue, never edits an issue other than the escalation's label
and comment and the digest, and never touches `packages/`. A repository the cockpit has registered
but the tick was not told to manage still counts toward capacity and the usage-limit pause, and is
otherwise left alone.
