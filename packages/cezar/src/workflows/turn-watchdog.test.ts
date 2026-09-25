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
 * A turn in flight that hears nothing from its runner is hung, and cezar stops it
 * (`TURN_INACTIVITY_TIMEOUT_MS`). The final step's turn had no bound at all: 8527e447
 * (2026-09-24) sat 46 minutes after `step-start` until cezar restarted. A parked run is not a
 * turn in flight - its bounds are the idle timer and the monitoring wake - so it is left alone.
 *
 * Driven dry through `scripts/mock-claude.mjs`: `mock:slow` holds the turn ~25 s without a
 * single event, far past the short bound these tests give the manager.
 */
describe('the in-flight turn watchdog', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let currentId: string | undefined;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  const SINGLE_STEP: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-watchdog-'));
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot, { turnInactivityMs: 1_500 });
    currentId = undefined;
  });

  afterEach(() => {
    if (currentId) manager.cancel(currentId);
    manager.dispose();
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
  const stalls = (id: string) =>
    store
      .readEvents(id)
      .filter((e) => e.type === 'error' && String((e as { message?: unknown }).message).startsWith('No agent activity'));
  const start = (task: string) => {
    const record = manager.startRun(SINGLE_STEP, { task, worktree: false });
    currentId = record.id;
    return record.id;
  };

  it('stops a turn that goes silent and fails the run', async () => {
    const id = start('mock:slow hang here');
    await waitFor(id, (r) => r?.status === 'failed');
    expect(stalls(id)).toHaveLength(1);
  }, 30_000);

  it('stops a silent turn that a message into a parked session started', async () => {
    const id = start('mock:ask pick a date library');
    await waitFor(id, (r) => r?.status === 'waiting');
    expect(manager.sendMessage(id, [{ type: 'text', text: 'mock:slow use date-fns' }])).toBe(true);
    await waitFor(id, (r) => r?.status === 'failed');
    expect(stalls(id)).toHaveLength(1);
  }, 30_000);

  // Guards: these behave exactly as before the watchdog.
  it('leaves a parked run alone past the bound', async () => {
    const id = start('mock:ask pick a date library');
    await waitFor(id, (r) => r?.status === 'waiting');
    await new Promise((r) => setTimeout(r, 3_000));
    expect(store.getRun(id)?.status).toBe('waiting');
    expect(stalls(id)).toEqual([]);
  }, 30_000);

  it('lets a turn that finishes inside the bound complete', async () => {
    const id = start('mock:done quick one');
    await waitFor(id, (r) => r?.status === 'done' || r?.status === 'failed');
    expect(store.getRun(id)?.status).toBe('done');
    expect(stalls(id)).toEqual([]);
  }, 30_000);
});
