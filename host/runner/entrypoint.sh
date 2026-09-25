#!/usr/bin/env bash
# One registration, one job, one writable layer. The host replaces this container after exit.
set -euo pipefail

: "${RUNNER_ORG:?RUNNER_ORG is required}"
: "${RUNNER_NAME:?RUNNER_NAME is required}"
: "${RUNNER_LABELS:?RUNNER_LABELS is required}"
: "${RUNNER_REGISTRATION_TOKEN:?RUNNER_REGISTRATION_TOKEN is required}"
RUNNER_GROUP="${RUNNER_GROUP:-vps}"

cd /home/runner/actions-runner
./config.sh \
  --unattended \
  --replace \
  --ephemeral \
  --disableupdate \
  --url "https://github.com/${RUNNER_ORG}" \
  --token "$RUNNER_REGISTRATION_TOKEN" \
  --name "$RUNNER_NAME" \
  --labels "$RUNNER_LABELS" \
  --runnergroup "$RUNNER_GROUP" \
  --work /home/runner/_work

unset RUNNER_REGISTRATION_TOKEN
# No persistent credential is needed for cleanup. Ephemeral runners deregister after their job;
# after a crash the next fresh container replaces the stale registration by name.
exec ./run.sh
