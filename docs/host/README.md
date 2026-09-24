# Host layer

Everything under `host/` is applied to a machine, not rendered into a repository. Nothing here is
generated and nothing verifies it: a green CI run in this repository means nothing about a host
that has not been touched. The `__PLACEHOLDER__` substitutions below are the whole mechanism.

Two services live here, both LaunchAgents, both `KeepAlive`:

```
host/launchd/dev.cezar.cockpit.plist    the cockpit: one `cezar serve` per host
host/runner/                            the self-hosted GitHub Actions runner pool
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

GitHub Actions minutes in this organisation went from 5 123 in August 2026 to 45 903 in the first
fortnight of September, against an Enterprise Cloud allowance of 50 000 a month. Everything under
`host/runner/` exists to move that load onto the host that already runs the cockpit.

```
host/runner/Dockerfile       the runner image: Playwright's own base, plus the runner
host/runner/entrypoint.sh    register ephemerally, take one job, deregister
host/runner/pool.sh          reconcile the pool to its declared size; safe to run at any time
host/runner/dev.gha-runner.pool.plist   launchd keeps pool.sh alive
```

**This repository does not use the pool.** Every job in its own workflows runs on `ubuntu-latest`.
The pool serves `planned.travel` and `money-tracker.online`; it lives here because it shares a host
with the cockpit, and the cockpit's repository is the only one of the three that is not a consumer
of it. See `docs/adr/0007-the-host-layer-lives-here.md`.

launchd keeps `pool.sh` alive. The supervisor leaves running containers alone, disables their old
restart policy without interrupting a job, and removes exited containers before creating replacements.
Docker restart reuses a writable layer; it is never isolation. Each replacement uses the immutable
image ID resolved from `GHA_RUNNER_IMAGE` (default `gha-runner:local`) for that cycle and runs
with `--restart=no`. Both CI and agent pools have no writable mounts, including package stores and
Node tool caches. All files written by a job disappear with its container. Downloads therefore cost
more than the previous shared caches, deliberately.

The organization PAT stays in the host's `GHA_RUNNER_TOKEN_FILE`; only the host calls GitHub's
registration-token endpoint. A container receives the short-lived registration token and unsets it
before starting the runner. No organization PAT, host home, Docker socket or credential file is mounted.
The registration token remains visible in Docker metadata until removal, so Docker access remains a
trusted host capability. `--ephemeral` deregisters completed jobs; `--replace` repairs registration
after a crash. A failed registration, launch, daemon connection or removal retries next cycle.

| Pool | Labels | Mounts | Runs |
| --- | --- | --- | --- |
| ci | `self-hosted,linux,ARM64,ci` | none | ci, a11y, merge-gate, promote |
| agent | `self-hosted,linux,ARM64,agent` | none | sentry-triage |

Size and ceilings are environment variables of `pool.sh`, set in the installed plist:

| Variable                                           | Default | Meaning                      |
| -------------------------------------------------- | ------- | ---------------------------- |
| `GHA_RUNNER_CI_COUNT` / `GHA_RUNNER_AGENT_COUNT`   | 6 / 2   | slots per pool               |
| `GHA_RUNNER_CI_CPUS` / `GHA_RUNNER_AGENT_CPUS`     | 3 / 2   | `--cpus` per container       |
| `GHA_RUNNER_CI_MEMORY` / `GHA_RUNNER_AGENT_MEMORY` | 6g / 4g | `--memory`, swap equal to it |

Without ceilings every container sees the whole OrbStack VM, and a burst of six CI jobs took this
host to a load average of ~500. The CPU quota also sizes the jobs themselves: Node's
`os.availableParallelism()` reports the quota, so vitest starts that many workers, not one per VM
core. Swap equal to memory means an over-budget job is OOM-killed rather than paged. `pool.sh`
applies changed ceilings to replacement containers, never to an active job, and it never
removes containers above a lowered count - stop and remove those by hand once they are idle.

Setting up the host:

```sh
mkdir -p ~/.config/gha-runner
printf '%s' '<PAT with manage_runners:org>' > ~/.config/gha-runner/token
chmod 600 ~/.config/gha-runner/token

docker build -t gha-runner:local host/runner
sed -e "s|__POOL_SH__|$PWD/host/runner/pool.sh|" -e "s|__HOME__|$HOME|" \
    -e "s|__PATH__|<PATH including the OrbStack docker shim>|" \
    host/runner/dev.gha-runner.pool.plist > ~/Library/LaunchAgents/dev.gha-runner.pool.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.gha-runner.pool.plist
```

The plist names a path to a token file, never a token. The organisation needs a runner group named
`local-mac`, scoped to exactly the repositories that may use it. Without the group every repository
in the organisation can schedule work on this Mac.

### Linux host

The same image and the same `pool.sh` run on a Linux machine under systemd instead of launchd. The
first one is the OVH VPS: x64, so its CI slots answer to `self-hosted,linux,X64,ci` and never
compete with the Mac's `ARM64` ones for a job; a repository picks a host by what its `RUNNER_CI`
names. The Dockerfile reads `TARGETARCH`, so `docker build` on the host produces the x64 image.

It differs from the Mac in one deliberate way: `GHA_RUNNER_ARTIFACTS_DIR` mounts a host directory
into every CI container at `/ci-artifacts`. `design4pro/.github`'s `artifact-upload` and
`artifact-download` actions write there when it exists, which keeps Playwright reports and coverage
off GitHub's 2 GB storage allowance (exhausted in September 2026, 1488 GB-hours against about 1440).
It is the only writable mount, it is not given to agent slots, and it holds data, never tools.

```sh
sudo useradd --system --create-home --home-dir /var/lib/gha-pool --groups docker gha-pool
sudo install -d -m 700 -o gha-pool /etc/gha-runner
printf '%s' '<classic PAT with the full admin:org scope>' | sudo tee /etc/gha-runner/token >/dev/null
sudo chown gha-pool /etc/gha-runner/token && sudo chmod 600 /etc/gha-runner/token
sudo install -m 644 host/runner/pool.env.example /etc/gha-runner/pool.env   # then edit

sudo docker build -t gha-runner:local host/runner
# The store belongs to the uid the image's `runner` user got, so jobs can write to it.
sudo install -d -m 750 -o "$(sudo docker run --rm --entrypoint id gha-runner:local -u)" /srv/ci-artifacts

sed -e "s|__POOL_SH__|$PWD/host/runner/pool.sh|" -e "s|__USER__|gha-pool|" \
    host/runner/gha-runner-pool.service | sudo tee /etc/systemd/system/gha-runner-pool.service >/dev/null
sudo systemctl daemon-reload && sudo systemctl enable --now gha-runner-pool
```

Its runner group is `vps`, scoped like `local-mac` to the repositories that may use it. A daily
systemd timer deletes `/srv/ci-artifacts/<repo>/<run>` directories older than 14 days.

### The kill switch

Jobs assigned to the CI pool read an organisation variable with the pool as their default:

```yaml
runs-on: ${{ fromJSON(vars.RUNNER_CI || '["self-hosted","linux","ARM64","ci"]') }}
```

Setting `RUNNER_CI` to `["ubuntu-latest"]` moves CI pool jobs back to GitHub-hosted runners
without a pull request. `RUNNER_AGENT` provides the same override for the agent pool. A LaunchAgent
runs only while the user is logged in, so these overrides restore validation after a host outage.
Production deployment and rollback already run on GitHub-hosted runners and do not depend on this
host; their recovery path remains available while the local pools are down.

### Why this stays a LaunchAgent

A LaunchAgent runs only while the user is logged in, so the obvious hardening is to move it to
`/Library/LaunchDaemons` and have it start at boot. On this host that buys nothing, and it is worth
saying why before someone spends an afternoon on it.

**The Docker engine is a user application.** OrbStack's engine runs as the logged-in user, out of
`/Applications/OrbStack.app`, and its socket is `~/.orbstack/run/docker.sock`, owned by that user.
The only thing OrbStack installs in `/Library/LaunchDaemons` is `privhelper`, an on-demand
MachService, not the engine. A pool daemon in the system domain would therefore start with no
engine to talk to and spin on `docker info` until somebody logged in. `pool.sh` tolerates that by
design, but a pool of zero containers is not what the daemon was installed for.

**FileVault decides the cold-boot case, not launchd.** With FileVault on, nothing at all runs after
a cold start until a human unlocks the disk - no daemon can precede the decryption that would let
it be read. And FileVault is not incidental here: `CLOUDFLARE_API_TOKEN`, `SENTRY_AUTH_TOKEN`,
`E2E_USER_PASSWORD` and the rest now materialise in containers on this disk, which is the
mitigation the migration plan recorded for exactly that regression.

What is already true is the case that actually comes up: unlocking FileVault at boot logs that user
in, OrbStack starts as a login item, and this agent's `RunAtLoad` starts the pool. For a _planned_
restart, unlock it in advance so no one has to be at the keyboard:

```sh
sudo fdesetup authrestart
```

That unlocks FileVault for exactly one reboot. A power cut is not covered, and cannot be while the
disk is encrypted - the kill switch above is the answer to that, not a different plist.

Making the pool genuinely independent of a login session is a runtime change, not a launchd change:
a container runtime that runs as a system service (Colima, or Docker CE in a VM supervised by a
LaunchDaemon) would make a pool LaunchDaemon meaningful. It would still not survive a cold boot
under FileVault.

### Bumping the runner image

The `FROM` tag in `host/runner/Dockerfile` must match the `@playwright/test` version resolved in
both consumer lockfiles. Playwright refuses to launch a browser build whose revision it did not
ship with, and the error names an executable rather than a version, so the failure does not read as
a version skew.

This pin is not new. It used to be spelled three times, as
`container: mcr.microsoft.com/playwright:<version>-noble` in planned.travel's e2e job and in
money-tracker.online's e2e and a11y jobs. Those directives are gone - both `e2e-env` composites
already declared that they assume "a runner that already carries the browsers" and never run
`playwright install`, and on a runner we build, that is the image's job. One place to bump instead
of three, but it is off to the side now, so: bump Playwright in a repository, bump this tag,
rebuild, and the running supervisor picks the new image ID up as containers finish. Do not start a
second supervisor alongside launchd.

### What the image must carry

A workflow written for `ubuntu-latest` is written against that image's preinstalled tooling, and it
never says so. `gh`, `bun`, `unzip`, `zip`, `xz` and `sudo` are simply there. Actions that look
self-contained are not: `oven-sh/setup-bun` downloads `bun-linux-aarch64.zip` and needs `unzip` to
open it, and `review-threads-label.mjs` shells out to `gh`.

Neither failure names what is missing. The bun one reported `bun: command not found` 2299 ms after a
successful download; the other, `spawnSync gh ENOENT` from a script nobody had changed. Both read as
a broken runner rather than a thin image.

The migration check that missed this asked whether any workflow uses `sudo`, `apt-get` or
`services:`. The answer was no, and the workflows broke anyway, because the question was about what
a workflow _declares_ rather than what it _assumes_. Before routing a new workflow onto the pool,
list the binaries its steps and its actions invoke and prove them present in the image, offline so
that nothing is quietly downloaded during the check:

```sh
docker run --rm --network none gha-runner:local \
  bash -lc 'for t in node pnpm gh unzip zip xz git jq curl; do command -v "$t" || echo "MISSING $t"; done'
```

### Rolling out disposable containers

1. Run the repository validation gate and `bash host/runner/test-isolation.sh` on a Docker host.
2. Build the reviewed image under a new tag and record its `docker image inspect` ID.
3. Point the installed pool service at the reviewed supervisor and image. Restart only the supervisor;
   never stop running job containers. Existing containers finish on their original image and mounts.
4. Verify replacements use the recorded ID, `RestartPolicy.Name=no`, and no mounts. Verify both pools
   accept and complete a job. Only then remove unused old cache volumes manually.

A host or daemon restart can fail an in-flight job; the supervisor recovers slots, not job progress.
Rolling back the supervisor to the former `--restart always` implementation restores the isolation bug;
prefer the organization hosted-runner override while diagnosing a failed rollout.

After reviewing the image and supervisor, the host-only commands are:

```sh
# Run from the reviewed checkout; keep this directory after installation.
runner_release="$HOME/.local/share/gha-runner/$(git rev-parse HEAD)"
mkdir -p "$runner_release"
cp host/runner/pool.sh "$runner_release/pool.sh"
docker build -t "gha-runner:$(git rev-parse --short HEAD)" host/runner
runner_image_id="$(docker image inspect --format '{{.Id}}' "gha-runner:$(git rev-parse --short HEAD)")"
runner_plist="$HOME/Library/LaunchAgents/dev.gha-runner.pool.plist"
cp "$runner_plist" "$runner_plist.before-disposable"
/usr/libexec/PlistBuddy -c "Set :ProgramArguments:1 $runner_release/pool.sh" "$runner_plist"
/usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables:GHA_RUNNER_IMAGE" "$runner_plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:GHA_RUNNER_IMAGE string $runner_image_id" "$runner_plist"
# This stops only pool.sh, not Docker containers. Do not stop or restart a job container.
launchctl bootout "gui/$(id -u)/dev.gha-runner.pool"
launchctl bootstrap "gui/$(id -u)" "$runner_plist"
```

Record the old container IDs first. Wait for active jobs to finish; a new container ID, pinned image
ID, no mounts and `RestartPolicy.Name=no` prove that slot migrated. Old idle runners may remain
until they take their final job; do not infer a fully migrated pool just from restarting launchd.
If a full drain is required, first move job routing to GitHub-hosted runners and confirm no busy
runners in the organization API before removing old idle containers. Restore routing only after
new registrations and a canary job succeed.
