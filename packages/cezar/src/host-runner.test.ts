import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pool = fileURLToPath(new URL('../../../host/runner/pool.sh', import.meta.url));
function reconcile(state: string, failure = '') {
  return execFileSync('bash', ['-c', `
    exec 2>&1
    source "$1"
    IMAGE_ID=sha256:pinned
    registration_token() { ${failure === 'token' ? 'return 1' : 'echo short-lived'}; }
    docker() {
      printf '%s\\n' "$*" >&2
      case "$1" in
        inspect) ${state === 'missing' ? 'return 1' : `echo ${state}`} ;;
        rm) ${failure === 'remove' ? 'return 1' : ':'} ;;
        run) ${failure === 'run' ? 'return 1' : ':'} ;;
      esac
    }
    ensure gha-ci-1 self-hosted,ci 3 6g || echo RETRY
  `, 'test', pool], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
describe('host runner reconciliation', () => {
  it.each(['running', 'paused', 'restarting'])('preserves %s containers during migration', (state) => {
    const output = reconcile(state);
    expect(output).toContain('update --restart=no gha-ci-1');
    expect(output).not.toContain('run --detach');
    expect(output).not.toContain('rm gha-ci-1');
  });
  it.each(['missing', 'exited', 'dead', 'created'])('replaces %s slots using a pinned image', (state) => {
    const output = reconcile(state);
    expect(output).toContain('--cpus 3 --memory 6g --memory-swap 6g');
    expect(output).toContain('--restart=no');
    expect(output).toContain('RUNNER_REGISTRATION_TOKEN=short-lived sha256:pinned');
    expect(output).not.toContain('--volume');
    if (state !== 'missing') expect(output.indexOf('rm gha-ci-1')).toBeLessThan(output.indexOf('run --detach'));
  });
  it.each(['token', 'remove', 'run'])('retries after %s failure', (failure) => {
    const output = reconcile('exited', failure);
    expect(output).toContain('RETRY');
    if (failure !== 'run') expect(output).not.toContain('run --detach');
  });
});
