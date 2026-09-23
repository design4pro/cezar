# The self-hosted runner image, and the reason three workflows no longer need `container:`.
#
# Base is the same image those workflows named themselves. planned.travel's e2e job,
# money-tracker.online's e2e job and its a11y job all declared
# `container: mcr.microsoft.com/playwright:vX-noble` for one reason: both `e2e-env` composite
# actions say in as many words that they assume "a runner that already carries the browsers", and
# neither ever runs `playwright install`. On GitHub-hosted infrastructure a job container was the
# only way to get that. On a runner we build, it is the runner's job - so the directive comes out
# of the workflows and the browsers come from here.
#
# This does NOT loosen a pin, it moves one. The tag below must match the `@playwright/test` version
# resolved in both consumer lockfiles, because Playwright refuses to launch a browser build whose
# revision it did not ship with ("Executable doesn't exist"). That coupling existed before this
# image did; it simply used to be spelled in ci.yml. See README, "Bumping the runner image".
FROM mcr.microsoft.com/playwright:v1.62.1-noble

# Node 24 and every browser Playwright supports on arm64 (Chromium and WebKit, which is what
# `devices['Desktop Chrome']`, `devices['iPhone 15']` and `devices['Desktop Safari']` resolve to -
# neither repository pins a branded channel, so nothing here needs Chrome or Edge proper) arrive
# with the base image, under PLAYWRIGHT_BROWSERS_PATH=/ms-playwright.
#
# git, curl and jq are the runner's own dependencies. openssl is the one the workflows have: both
# `e2e-env` composites generate a session secret with `openssl rand -base64 32`.
#
# The rest are here because a hosted runner ships them and workflows are written against that
# assumption without ever declaring it. Both gaps were found the same way - by a red job, not by
# reading a workflow:
#
#   unzip  `anthropics/claude-code-action@v1` runs on Bun, and its `oven-sh/setup-bun` step
#          downloads `bun-linux-aarch64.zip` and extracts it. Without unzip that step fails in two
#          seconds and the next one reports `bun: command not found`, which names neither the
#          archive nor the missing tool (planned.travel run 34847597323).
#   gh     `scripts/ci/review-threads-label.mjs` shells out to it, and so does
#          `git-guardrails.sh`. Missing, node reports `spawnSync gh ENOENT`.
#
# zip and xz-utils earn their place as the other half of the same family rather than by a failure
# of their own: an action that fetches a release asset picks the archive format, and having only
# one extractor is the state that just cost two red pull requests.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git curl jq openssl ca-certificates unzip zip xz-utils \
 && rm -rf /var/lib/apt/lists/*

# The GitHub CLI is not in Ubuntu's archive, so it comes from its own. Keyring and source list
# rather than a release tarball: apt then carries the upgrade path, and the architecture is read
# from dpkg instead of being hard-coded to arm64 here.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Not root. The runner application tolerates it, but a job that runs arbitrary pull-request code
# should not start with the ability to rewrite the image it is running in. The uid is left to
# useradd rather than pinned: the base image already ships `ubuntu` at 1000 and `pwuser` at 1001,
# and nothing here needs a particular number.
RUN useradd --create-home --shell /bin/bash runner

# pnpm is pinned to the version money-tracker.online's setup action pins, and the one both
# repositories name in `packageManager`. planned.travel's setup action is deliberately unpinned and
# reads that field, and corepack honours it at run time regardless of what is baked here - so this
# is a warm cache, not an override.
#
# COREPACK_HOME is the whole reason this works. Without it `corepack prepare` writes into the
# building user's cache (root's), the job runs as `runner` with an empty one, and corepack silently
# resolves "latest" and downloads a different pnpm on every container start. That is not a warning
# anywhere - it shows up only as a version you did not ask for in `pnpm -v`.
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable \
 && corepack prepare pnpm@10.15.0 --activate \
 && chown -R runner:runner /opt/corepack

# TARGETARCH comes from BuildKit: arm64 on the Mac, amd64 on the Linux host. The runner's release
# assets spell the latter x64, which is the only translation needed - the base image is multi-arch.
ARG RUNNER_VERSION=2.337.0
ARG TARGETARCH
WORKDIR /home/runner/actions-runner
RUN case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) arch=x64 ;; arm64) arch=arm64 ;; *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o runner.tar.gz \
      "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${arch}-${RUNNER_VERSION}.tar.gz" \
 && tar xzf runner.tar.gz \
 && rm runner.tar.gz \
 && ./bin/installdependencies.sh \
 && chown -R runner:runner /home/runner

# Where `actions/setup-node` caches the Node it downloads. This is container-local and dies
# with the container, so a previous job cannot poison a later job through executable caches.
ENV RUNNER_TOOL_CACHE=/opt/hostedtoolcache
RUN mkdir -p /opt/hostedtoolcache && chown runner:runner /opt/hostedtoolcache

COPY --chown=runner:runner entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh

USER runner
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
