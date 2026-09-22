#!/usr/bin/env bash
# Offline, opt-in Docker integration check. Uses unique test containers; never touches pool slots.
set -euo pipefail
source "$(dirname "$0")/pool.sh"
IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$IMAGE")"
name="gha-isolation-test-$$"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
registration_token() { echo test-only; }
# Run a harmless shell instead of contacting GitHub. All production docker flags still pass through.
docker() {
  if [[ "$1" == run ]]; then
    shift
    local args=()
    while (( $# > 1 )); do args+=("$1"); shift; done
    command docker run --entrypoint /bin/sh "${args[@]}" "$1" -c 'sleep 300'
  else
    command docker "$@"
  fi
}
ensure "$name" test 1 256m
first="$(docker inspect --format '{{.Id}}' "$name")"
docker exec "$name" sh -c 'echo previous-job > /home/runner/job-marker'
ensure "$name" test 1 256m
[[ "$(docker inspect --format '{{.Id}}' "$name")" == "$first" ]]
docker exec "$name" test -f /home/runner/job-marker
# A failed job exits. Reconciliation must discard its layer, not restart it.
docker kill "$name" >/dev/null
# Re-source the supervisor as a host process restart would do; no memory is required for recovery.
source "$(dirname "$0")/pool.sh"
ensure "$name" test 1 256m
[[ "$(docker inspect --format '{{.Id}}' "$name")" != "$first" ]]
docker exec "$name" test ! -f /home/runner/job-marker
[[ "$(docker inspect --format '{{.Image}}' "$name")" == "$IMAGE_ID" ]]
[[ "$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$name")" == no ]]
[[ "$(docker inspect --format '{{len .Mounts}}' "$name")" == 0 ]]
printf 'Runner isolation: active container preserved; replacement layer clean; image pinned; no mounts.\n'
