# The host layer lives in this repository

The launchd services and the self-hosted GitHub Actions runner pool that the design4pro pipeline runs on live under `host/`, documented in `docs/host/README.md`. They came from `design4pro/agent-kit`, which was retired in September 2026 when its two consumer repositories stopped taking rendered files from it. Nothing renders `host/`: it is installed onto a machine by hand, with `__PLACEHOLDER__` substitution, and no CI run in any repository can tell whether a host was touched.

The cockpit half is a natural fit. One `cezar serve` per host serves every project in `~/.cezar/config.json`, the installed plist already names this checkout as its boot repo, and the reason the cockpit runs the `design4pro` fork rather than `npx` — five commits upstream has not shipped, each with a silent failure mode — had no home in this repository's docs before.

The runner-pool half is placed, not derived. **This repository does not use the pool**: every job in its own workflows runs on `ubuntu-latest`. The pool exists for `planned.travel` and `money-tracker.online`, and putting it in a third repository that never schedules on it is the same "a host-wide service is nobody's property" problem agent-kit was created to solve, relocated rather than answered. It earns the placement by sharing a host with the cockpit and by being the one repository of the three whose lifetime is not tied to either application.

## Considered Options

- **Leave it in `agent-kit`, host-only:** rejected. Keeping a repository alive solely to hold five files preserves the coupling the retirement was meant to end, and the checkout's continued presence on disk is itself load-bearing — `~/Library/LaunchAgents/dev.gha-runner.pool.plist` names `pool.sh` by absolute path.
- **A dedicated infrastructure repository:** cleaner in principle, and the right answer if the pool grows beyond one host. Rejected now as a fourth repository serving five files.
- **Duplicate it into both application repos:** rejected. One host, one pool, one cockpit; two copies of shared machine state is what produced the drift that motivated agent-kit in the first place.

## Consequences

Changing the pool's size or image is a pull request here, against `design4pro`, by someone who is not the pool's user — so `docs/host/README.md` has to carry the operational context that would otherwise live with the consumer. The `FROM` tag in `host/runner/Dockerfile` stays coupled to `@playwright/test` in two other lockfiles, with nothing automated to catch a skew. Moving the pool means re-rendering the installed plist and `launchctl bootout`/`bootstrap`; the running containers do not follow a `git mv`. The kill switch — organisation variables `RUNNER_CI` and `RUNNER_AGENT` set to `["ubuntu-latest"]` — remains the recovery path that needs neither this repository nor a working host.
