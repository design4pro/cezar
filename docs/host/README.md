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

Three layers, each with one job. launchd keeps `pool.sh` alive, `pool.sh` keeps the containers
alive, and `--restart always` plus `--ephemeral` recycle a container after every single job. The
recycling is the point rather than a side effect: `claude-code-review.yml` runs an agent with
`--permission-mode bypassPermissions` and justifies it in a comment with "the runner is
disposable". On GitHub-hosted infrastructure that was a property of the platform. Here it is a
property of `entrypoint.sh`, and it has to be restated there or the justification quietly becomes
false.

Two pools, told apart by label and by what they mount:

| Pool  | Labels                          | Mounts                      | Runs                                      |
| ----- | ------------------------------- | --------------------------- | ----------------------------------------- |
| ci    | `self-hosted,linux,ARM64,ci`    | pnpm store, Node tool cache | ci, a11y, deploys, merge-gate, promote    |
| agent | `self-hosted,linux,ARM64,agent` | nothing                     | claude, claude-code-review, sentry-triage |

CI jobs execute arbitrary pull-request code too, so the ci pool's containers are no longer lived
than the agent pool's - what differs is that a content-addressed package store consumed under
`--frozen-lockfile` and a Node tarball cache survive between them. A workspace never does. The
browsers are not a mount either: they are in the image, so there is nothing there for a job to
poison.

A container between jobs is restarting, not missing, which is why `pool.sh` uses `docker inspect`
rather than `docker ps` as its existence check. A SIGKILL or an OOM leaves `.runner` and
`.credentials` behind, and `--replace` does not rescue that because `config.sh` refuses locally
first; `entrypoint.sh` clears the stale config itself, or `--restart always` would crash-loop
forever. That is how one container was found dead while the others looked healthy.

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
applies changed ceilings to running containers with `docker update` on its next cycle, but it never
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

### The kill switch

Every `runs-on` reads an organisation variable with the pool as its default:

```yaml
runs-on: ${{ fromJSON(vars.RUNNER_CI || '["self-hosted","linux","ARM64","ci"]') }}
```

Setting `RUNNER_CI` to `["ubuntu-latest"]` moves every job back to GitHub-hosted runners in
seconds, with no pull request and no merge. That matters because a LaunchAgent runs only while the
user is logged in, and production deploys now depend on it: the recovery path for a host that is
down cannot itself require merging a pull request on that host.

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
rebuild, and `bash host/runner/pool.sh` picks the new image up as containers recycle.

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
