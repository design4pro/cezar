import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pool = fileURLToPath(new URL('../../../host/runner/pool.sh', import.meta.url));
function reconcile(state: string, failure = '', artifacts = '') {
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
    ensure vps-ci-1 self-hosted,ci 4 8g ${artifacts} || echo RETRY
  `, 'test', pool], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
describe('host runner reconciliation', () => {
  it.each(['running', 'paused', 'restarting'])('preserves %s containers during migration', (state) => {
    const output = reconcile(state);
    expect(output).toContain('update --restart=no vps-ci-1');
    expect(output).not.toContain('run --detach');
    expect(output).not.toContain('rm vps-ci-1');
  });
  it.each(['missing', 'exited', 'dead', 'created'])('replaces %s slots using a pinned image', (state) => {
    const output = reconcile(state);
    expect(output).toContain('--cpus 4 --memory 8g --memory-swap 8g');
    expect(output).toContain('--restart=no');
    expect(output).toContain('RUNNER_REGISTRATION_TOKEN=short-lived sha256:pinned');
    expect(output).not.toContain('--volume');
    if (state !== 'missing') expect(output.indexOf('rm vps-ci-1')).toBeLessThan(output.indexOf('run --detach'));
  });
  it('mounts the artifact store only when one is given', () => {
    const output = reconcile('missing', '', '/srv/ci-artifacts');
    expect(output).toContain('--volume /srv/ci-artifacts:/ci-artifacts');
    expect(output.match(/--volume/g)).toHaveLength(1);
  });
  it.each(['token', 'remove', 'run'])('retries after %s failure', (failure) => {
    const output = reconcile('exited', failure);
    expect(output).toContain('RETRY');
    if (failure !== 'run') expect(output).not.toContain('run --detach');
  });
  it('declares ci and agent slots, mounting the artifact store on ci slots only', () => {
    const output = execFileSync('bash', ['-c', `
      exec 2>&1
      source "$1"
      IMAGE_ID=sha256:pinned
      registration_token() { echo short-lived; }
      docker() {
        case "$1" in
          inspect) return 1 ;;
          run) printf 'RUN %s\\n' "$*" >&2 ;;
        esac
      }
      reconcile_once
    `, 'test', pool], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const runs = output.split('\n').filter((line) => line.startsWith('RUN '));
    const slot = (name: string) => runs.find((line) => line.includes(`--name ${name} `)) ?? '';
    expect(runs).toHaveLength(3);
    for (const name of ['vps-ci-1', 'vps-ci-2']) {
      expect(slot(name)).toContain('RUNNER_LABELS=self-hosted,linux,X64,ci');
      expect(slot(name)).toContain('--cpus 4 --memory 8g');
      expect(slot(name)).toContain('--volume /srv/ci-artifacts:/ci-artifacts');
    }
    expect(slot('vps-gate-1')).toBe('');
    expect(slot('vps-agent-1')).toContain('RUNNER_LABELS=self-hosted,linux,X64,agent');
    expect(slot('vps-agent-1')).not.toContain('--volume');
    expect(runs.every((line) => line.includes('RUNNER_GROUP=vps'))).toBe(true);
  });
});
