import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * A transient OAuth refresh failure gets one retry of the same step (`core/auth-refresh.ts`). On
 * 2026-10-02 four scheduled housekeeping runs failed at their first agent step on it, and the
 * steps after it never ran.
 *
 * Driven dry through `scripts/mock-claude.mjs`: `mock:auth-refresh` fails every attempt,
 * `mock:auth-refresh-once` only the first. The workflow ends with a check step, like housekeeping,
 * so the agent step is not the interactive last one and the later step shows whether the run went on.
 */
describe('a transient OAuth refresh failure retries the step once', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  const WORKFLOW: WorkflowDef = {
    name: 'auth-refresh',
    source: 'built-in',
    steps: [
      { id: 'review', name: 'Review', prompt: '{{task}}' },
      { id: 'after', name: 'After', command: 'true' },
    ],
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-auth-refresh-'));
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  afterEach(() => {
    manager?.dispose();
    manager = undefined;
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const waitFor = async (id: string, pred: (r: RunRecord | undefined) => boolean, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!pred(store.getRun(id))) {
      if (Date.now() > deadline) throw new Error(`condition not met in time (status ${store.getRun(id)?.status})`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const settled = (r: RunRecord | undefined) => r?.status === 'done' || r?.status === 'failed' || r?.status === 'cancelled';
  const retryNotes = (id: string) =>
    store.readEvents(id).filter((e) => e.type === 'note' && String(e.message ?? '').includes('could not refresh its login token'));
  const step = (id: string, stepId: string) => store.getRun(id)?.steps.find((s) => s.id === stepId);

  const start = (task: string, authRefreshRetryDelayMs = 50) => {
    manager = new RunManager(store, repoRoot, { authRefreshRetryDelayMs });
    return manager.startRun(WORKFLOW, { task, worktree: false, autonomous: true }).id;
  };

  it('goes on with the workflow when the retry works', async () => {
    const id = start('mock:auth-refresh-once mock:done review the queue');
    await waitFor(id, settled);
    expect(store.getRun(id)?.status).toBe('done');
    expect(retryNotes(id)).toHaveLength(1);
    expect(step(id, 'review')).toMatchObject({ status: 'done', iterations: 2 });
    expect(step(id, 'after')?.status).toBe('done');
  }, 40_000);

  it('fails the run after the one retry when the refresh keeps failing', async () => {
    const id = start('mock:auth-refresh review the queue');
    await waitFor(id, settled);
    expect(store.getRun(id)?.status).toBe('failed');
    expect(store.getRun(id)?.error).toContain('Failed to refresh OAuth token');
    expect(retryNotes(id)).toHaveLength(1);
    expect(step(id, 'review')).toMatchObject({ status: 'failed', iterations: 2 });
    expect(step(id, 'after')?.status).toBe('pending');
  }, 40_000);

  it('cancels promptly while waiting for the retry', async () => {
    const id = start('mock:auth-refresh review the queue', 60_000);
    await waitFor(id, () => retryNotes(id).length === 1);
    expect(manager?.cancel(id)).toBe(true);
    await waitFor(id, settled, 5_000);
    expect(store.getRun(id)?.status).toBe('cancelled');
    expect(step(id, 'review')?.iterations).toBe(1);
  }, 40_000);

  // Guard: passes with or without the change - any other auth failure still fails at once.
  it('does not retry a revoked token', async () => {
    const id = start('mock:auth-error review the queue');
    await waitFor(id, settled);
    expect(store.getRun(id)?.status).toBe('failed');
    expect(retryNotes(id)).toEqual([]);
    expect(step(id, 'review')?.iterations).toBe(1);
  }, 40_000);
});
