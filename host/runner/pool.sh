#!/usr/bin/env bash
# Reconcile disposable single-job containers. Never restart a writable layer or stop an active job.
# The organization credential stays on the host; containers receive only a registration token.
set -euo pipefail

IMAGE="${GHA_RUNNER_IMAGE:-gha-runner:local}"
ORG="${GHA_RUNNER_ORG:-design4pro}"
GROUP="${GHA_RUNNER_GROUP:-vps}"
TOKEN_FILE="${GHA_RUNNER_TOKEN_FILE:-/etc/gha-runner/token}"
INTERVAL="${GHA_RUNNER_INTERVAL:-60}"

# The host is an OVH VPS: 8 KVM vCPUs (Intel Haswell) and 22 GB. Measured on 2026-09-24, one of
# its cores does about a third of the work of an Apple-silicon core, so CI slots are few and wide:
# three slots of three CPUs pushed planned.travel's e2e shards past their 900 s budget, and two
# of four did not. Three pools share the machine:
#
#   ci     the gate's real work - build, unit, e2e, a11y, deploys. CPU-bound.
#   gate   seconds-long jobs - merge gates, auto-merge, promotion. Without a slot of their own
#          they queue behind a 15-minute e2e shard and hold every pull request with them.
#   agent  sentry-triage and other agent runs, network-bound almost all of their wall time.
#
# gate and agent oversubscribe the eight cores on purpose; they rarely use their quota.
CI_COUNT="${GHA_RUNNER_CI_COUNT:-2}"
GATE_COUNT="${GHA_RUNNER_GATE_COUNT:-1}"
AGENT_COUNT="${GHA_RUNNER_AGENT_COUNT:-1}"

# What a slot is called and what it answers to. The container name is also the runner's
# registration name, and registration uses --replace, so two hosts sharing a prefix would take
# each other's registrations: a second host needs its own prefix.
PREFIX="${GHA_RUNNER_NAME_PREFIX:-vps}"
CI_LABELS="${GHA_RUNNER_CI_LABELS:-self-hosted,linux,X64,ci}"
GATE_LABELS="${GHA_RUNNER_GATE_LABELS:-self-hosted,linux,X64,gate}"
AGENT_LABELS="${GHA_RUNNER_AGENT_LABELS:-self-hosted,linux,X64,agent}"

# The one writable mount a pool may have, and only the CI pool: a host directory mounted at
# /ci-artifacts, where design4pro/.github's artifact-upload/-download actions keep a run's
# artifacts instead of GitHub's storage. Empty means no mount at all. It is shared by every job of
# every repository in the runner group - an artifact store, never a cache: nothing a job reads
# from it is executed by the toolchain on its own.
ARTIFACTS_DIR="${GHA_RUNNER_ARTIFACTS_DIR-/srv/ci-artifacts}"

# Per-container ceilings. Without them every container sees the whole machine and a burst of CI
# jobs drives the load average into the hundreds. `--cpus` is a CFS quota that Node's
# os.availableParallelism() honours, so vitest sizes its worker pool to the quota rather than to
# the host's core count. Swap equals memory: a job that outgrows its ceiling is OOM-killed, not
# paged.
CI_CPUS="${GHA_RUNNER_CI_CPUS:-4}"
CI_MEMORY="${GHA_RUNNER_CI_MEMORY:-8g}"
GATE_CPUS="${GHA_RUNNER_GATE_CPUS:-1}"
GATE_MEMORY="${GHA_RUNNER_GATE_MEMORY:-2g}"
AGENT_CPUS="${GHA_RUNNER_AGENT_CPUS:-2}"
AGENT_MEMORY="${GHA_RUNNER_AGENT_MEMORY:-4g}"

log() { printf '%s pool: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

registration_token() {
  # Keep the organization credential out of argv, container metadata and logs.
  printf 'header = "Authorization: Bearer %s"\n' "$(cat "$TOKEN_FILE")" |
    curl --config - --fail --silent --show-error --max-time 30 -X POST \
      -H 'Accept: application/vnd.github+json' \
      -H 'X-GitHub-Api-Version: 2022-11-28' \
      "https://api.github.com/orgs/${ORG}/actions/runners/registration-token" |
    jq -er '.token | select(type == "string" and length > 0)'
}

ensure() {
  local name="$1" labels="$2" cpus="$3" memory="$4" artifacts="${5:-}"
  local state token mounts=()
  state="$(docker inspect --type container --format '{{.State.Status}}' "$name" 2>/dev/null)" || state=missing
  case "$state" in
    running|paused|restarting)
      # A reconcile must never interrupt a running job. Only change restart policy;
      # resource/image changes take effect on its replacement, never midway through a job.
      docker update --restart=no "$name" >/dev/null || return 1
      return 0 ;;
    exited|dead|created)
      # No --force: a concurrent start is a safe failure, never permission to kill a job.
      docker rm "$name" >/dev/null || return 1 ;;
    missing) ;;
    *) log "unknown state for $name; leaving it alone"; return 1 ;;
  esac
  token="$(registration_token)" || { log "registration failed for $name; retrying next cycle"; return 1; }
  [ -n "$artifacts" ] && mounts=(--volume "$artifacts:/ci-artifacts")
  log "creating $name [$labels] from $IMAGE_ID"
  docker run --detach \
    --name "$name" \
    --restart=no \
    --hostname "$name" \
    --cpus "$cpus" --memory "$memory" --memory-swap "$memory" \
    ${mounts[@]+"${mounts[@]}"} \
    --env "RUNNER_ORG=$ORG" \
    --env "RUNNER_NAME=$name" \
    --env "RUNNER_LABELS=$labels" \
    --env "RUNNER_GROUP=$GROUP" \
    --env "RUNNER_REGISTRATION_TOKEN=$token" \
    "$IMAGE_ID" >/dev/null
}

# One pass over every slot. The caller has resolved IMAGE_ID for this cycle.
reconcile_once() {
  local i
  for ((i=1; i<=CI_COUNT; i++)); do
    ensure "$PREFIX-ci-$i" "$CI_LABELS" "$CI_CPUS" "$CI_MEMORY" "$ARTIFACTS_DIR" || log "retrying $PREFIX-ci-$i next cycle"
  done
  for ((i=1; i<=GATE_COUNT; i++)); do
    ensure "$PREFIX-gate-$i" "$GATE_LABELS" "$GATE_CPUS" "$GATE_MEMORY" || log "retrying $PREFIX-gate-$i next cycle"
  done
  for ((i=1; i<=AGENT_COUNT; i++)); do
    ensure "$PREFIX-agent-$i" "$AGENT_LABELS" "$AGENT_CPUS" "$AGENT_MEMORY" || log "retrying $PREFIX-agent-$i next cycle"
  done
}

main() {
  [ -r "$TOKEN_FILE" ] || { log "cannot read runner token file"; return 1; }
  while :; do
    if docker info >/dev/null 2>&1; then
      # Resolve the mutable tag once per cycle; each new container is pinned to that immutable ID.
      if IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$IMAGE")"; then
        reconcile_once
      else
        log "runner image unavailable; retrying next cycle"
      fi
    else
      log "docker unreachable; retrying in ${INTERVAL}s"
    fi
    sleep "$INTERVAL"
  done
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main; fi
