#!/usr/bin/env bash
# Keeps the runner pool at its declared size. launchd keeps this script alive; this script keeps
# the containers alive; `--restart=always` and `--ephemeral` between them recycle a container after
# every single job. Three layers, each with one responsibility.
#
# It reconciles rather than creates: a container that already exists and runs is left alone, so
# running this by hand at any moment is safe and is the intended way to apply a size change.
set -euo pipefail

IMAGE="${GHA_RUNNER_IMAGE:-gha-runner:local}"
ORG="${GHA_RUNNER_ORG:-design4pro}"
GROUP="${GHA_RUNNER_GROUP:-local-mac}"
TOKEN_FILE="${GHA_RUNNER_TOKEN_FILE:-$HOME/.config/gha-runner/token}"
INTERVAL="${GHA_RUNNER_INTERVAL:-60}"

# Six CI slots and two agent slots against sixteen cores, with the cezar cockpit's
# resources.maxParallel of 4 already on this host. The agent runs are network-bound almost all of
# their wall time, the CI jobs are not, which is the whole basis for oversubscribing. Raise CI
# first and only after watching a burst: a planned.travel CI event alone fans out to eight jobs.
CI_COUNT="${GHA_RUNNER_CI_COUNT:-6}"
AGENT_COUNT="${GHA_RUNNER_AGENT_COUNT:-2}"

# Per-container ceilings. Without them every container saw the whole VM, and six CI jobs at once
# drove the host to a load average of ~500. `--cpus` is a CFS quota that Node's
# os.availableParallelism() honours, so vitest sizes its worker pool to the quota rather than to the
# VM's core count. Swap equals memory: a job that outgrows its ceiling is OOM-killed, not paged.
CI_CPUS="${GHA_RUNNER_CI_CPUS:-3}"
CI_MEMORY="${GHA_RUNNER_CI_MEMORY:-6g}"
AGENT_CPUS="${GHA_RUNNER_AGENT_CPUS:-2}"
AGENT_MEMORY="${GHA_RUNNER_AGENT_MEMORY:-4g}"

log() { printf '%s pool: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

ensure() {
  local name="$1" labels="$2" cpus="$3" memory="$4"; shift 4
  local limits=(--cpus "$cpus" --memory "$memory" --memory-swap "$memory")
  # `docker inspect` is the check rather than `docker ps`, because a container that exited between
  # jobs is restarting, not missing, and recreating it would race the restart.
  if docker inspect --type container "$name" >/dev/null 2>&1; then
    # A restart reuses the container's original flags, so limits reach an existing container only
    # through `docker update` - which keeps a limit change on the same path as a size change.
    docker update "${limits[@]}" "$name" >/dev/null || log "could not apply limits to $name"
    return 0
  fi
  log "creating $name [$labels]"
  docker run --detach \
    --name "$name" \
    --restart always \
    --hostname "$name" \
    --env "RUNNER_ORG=$ORG" \
    --env "RUNNER_NAME=$name" \
    --env "RUNNER_LABELS=$labels" \
    --env "RUNNER_GROUP=$GROUP" \
    --volume "$TOKEN_FILE:/run/secrets/gha-token:ro" \
    "$@" \
    "$IMAGE" >/dev/null
}

[ -r "$TOKEN_FILE" ] || { log "cannot read $TOKEN_FILE - see README, 'The runner pool'"; exit 1; }

while :; do
  if docker info >/dev/null 2>&1; then
    # The ci pool carries warm caches; the agent pool deliberately carries none. What survives a CI
    # job here is a content-addressed package store consumed under --frozen-lockfile and a Node
    # tarball cache - not a workspace. The browsers are not a volume: they are baked into the image
    # at /ms-playwright, so there is nothing for a job to poison and nothing to restore.
    for i in $(seq 1 "$CI_COUNT"); do
      ensure "gha-ci-$i" "self-hosted,linux,ARM64,ci" "$CI_CPUS" "$CI_MEMORY" \
        --volume gha-pnpm-store:/home/runner/.local/share/pnpm/store \
        --volume gha-toolcache:/opt/hostedtoolcache
    done
    for i in $(seq 1 "$AGENT_COUNT"); do
      ensure "gha-agent-$i" "self-hosted,linux,ARM64,agent" "$AGENT_CPUS" "$AGENT_MEMORY"
    done
  else
    log "docker unreachable - is OrbStack running? retrying in ${INTERVAL}s"
  fi
  sleep "$INTERVAL"
done
