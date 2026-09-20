#!/usr/bin/env bash
# One container, one job, then gone.
#
# `--ephemeral` is what keeps the sentence claude-code-review.yml relies on true. That workflow
# runs an agent with `--permission-mode bypassPermissions` and justifies it in a comment with "the
# runner is disposable". On GitHub-hosted infrastructure that was a property of the platform. Here
# it is a property of this file: the runner takes exactly one job, deregisters itself, and run.sh
# exits. Docker's `--restart=always` then starts a new container from the unmodified image, which
# re-registers from scratch. Nothing a job writes outside a mounted volume survives that.
#
# The pool script mounts a personal access token in as a FILE, never as an environment variable.
# Cezar's cockpit forwards every CLAUDE_*, ANTHROPIC_* and CEZ_* variable in its environment into
# every agent run it starts; a token exported here would be a token in those runs too. A path is
# not a token - the same reasoning that put GH_CONFIG_DIR rather than a credential into
# dev.cezar.cockpit.plist.
set -euo pipefail

: "${RUNNER_ORG:?RUNNER_ORG is required}"
: "${RUNNER_NAME:?RUNNER_NAME is required}"
: "${RUNNER_LABELS:?RUNNER_LABELS is required}"
RUNNER_GROUP="${RUNNER_GROUP:-local-mac}"
TOKEN_FILE="${RUNNER_TOKEN_FILE:-/run/secrets/gha-token}"

[ -r "$TOKEN_FILE" ] || { echo "entrypoint: cannot read $TOKEN_FILE" >&2; exit 1; }
PAT="$(cat "$TOKEN_FILE")"

api() {
  curl -fsSL -X POST \
    -H "Authorization: Bearer ${PAT}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/orgs/${RUNNER_ORG}/actions/runners/${1}" | jq -r '.token'
}

cd /home/runner/actions-runner

# A container that dies without its trap running - SIGKILL, an OOM, a Docker daemon restart, or a
# job that took the runner process down with it - leaves .runner and .credentials behind in the
# writable layer. `--replace` does not rescue that: it replaces the registration GitHub holds,
# while config.sh refuses earlier, on the local files alone, with "Cannot configure the runner
# because it is already configured". `--restart always` then retries that same refusal forever, so
# the slot is not merely down, it is permanently down and absent from the pool listing - which is
# how gha-ci-3 was found, crash-looping while the other seven looked healthy.
#
# Deregister politely if the leftover credentials still work, then delete the files either way. The
# ghost registration a failed remove leaves behind is exactly what --replace below is for.
if [ -f .runner ]; then
  echo "entrypoint: stale runner config found - clearing it before registering"
  ./config.sh remove --token "$(api remove-token)" >/dev/null 2>&1 || true
  rm -f .runner .credentials .credentials_rsaparams
fi

# Registration tokens live one hour, which is why they are fetched per container start rather than
# handed down from the pool script.
./config.sh \
  --unattended \
  --replace \
  --ephemeral \
  --disableupdate \
  --url "https://github.com/${RUNNER_ORG}" \
  --token "$(api registration-token)" \
  --name "$RUNNER_NAME" \
  --labels "$RUNNER_LABELS" \
  --runnergroup "$RUNNER_GROUP" \
  --work /home/runner/_work

# A container stopped while idle has a registration GitHub still believes in; it shows as an
# offline runner and, worse, `--replace` on the next start is the only thing that cleans it up.
# Remove it deliberately instead. Note this cannot be `exec ./run.sh` - exec replaces the shell and
# takes the trap with it, so run.sh goes to the background and we wait on it.
cleanup() {
  trap - TERM INT
  ./config.sh remove --token "$(api remove-token)" >/dev/null 2>&1 || true
}
trap cleanup TERM INT

./run.sh &
wait $!
