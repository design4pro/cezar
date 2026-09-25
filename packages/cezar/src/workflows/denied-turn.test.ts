import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
 * A permission denial ends the session only when the agent could not finish the turn (spec
 * 2026-09-10-dispatch). On 2026-09-24/25, 12 runs failed on a denial; 4 of them had already
 * ended with `CEZ:DONE` and 1 with a `CEZ:ASK`, and those settle now. A denied turn that ends
 * with `CEZ:MONITORING` or no marker still fails, and nothing - the autonomous nudge included -
 * continues a denied turn on its own.
 *
 * Driven dry through `scripts/mock-claude.mjs`: `mock:denied` puts a `permission_denials`
 * entry on the turn's result frame.
 */
describe('a permission-denied turn settles only when the agent finished it', () => {
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
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-denied-'));
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
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

  const readEvents = (id: string): Array<{ type: string; message?: string }> => {
    const path = join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; message?: string });
  };
  const deniedErrors = (id: string) =>
    readEvents(id).filter((e) => e.type === 'error' && String(e.message).startsWith('Permission denied'));
  const deniedNotes = (id: string) =>
    readEvents(id).filter((e) => e.type === 'note' && String(e.message).startsWith('Permission denied: Edit .claude/settings.json'));
  const nudges = (id: string) =>
    readEvents(id).filter((e) => e.type === 'note' && String(e.message).includes('autonomous — continuing'));

  const start = (task: string) => {
    const record = manager.startRun(SINGLE_STEP, { task, worktree: false, autonomous: true });
    currentId = record.id;
    return record.id;
  };

  it('settles a denied turn that ended with CEZ:DONE', async () => {
    const id = start('mock:denied mock:done finish up');
    await waitFor(id, (r) => r?.status === 'done' || r?.status === 'failed');
    expect(store.getRun(id)?.status).toBe('done');
    expect(deniedErrors(id)).toEqual([]);
    expect(deniedNotes(id)).toHaveLength(1);
  }, 40_000);

  it('parks a denied CEZ:ASK for the user, and the autonomous nudge does not override it', async () => {
    const id = start('mock:denied mock:ask pick a date library');
    await waitFor(id, (r) => r?.status === 'waiting' || r?.status === 'failed');
    expect(store.getRun(id)?.status).toBe('waiting');
    expect(deniedErrors(id)).toEqual([]);
    expect(deniedNotes(id)).toHaveLength(1);
    expect(nudges(id)).toEqual([]);
    expect(readEvents(id).some((e) => e.type === 'ask.requested')).toBe(true);
  }, 40_000);

  it('parks a denied CEZ:ASK in a continuation too (the other turn-end handler)', async () => {
    const id = start('mock:done first pass');
    await waitFor(id, (r) => r?.status === 'done');
    expect(manager.continueRun(id, { text: 'mock:denied mock:ask pick a date library' })).toEqual({ ok: true });
    await waitFor(id, (r) => r?.status === 'waiting' || r?.status === 'failed');
    expect(store.getRun(id)?.status).toBe('waiting');
    expect(deniedErrors(id)).toEqual([]);
    expect(nudges(id)).toEqual([]);
  }, 40_000);

  // Guards: these fail exactly as before the change.
  it('still fails a denied turn that ended with CEZ:MONITORING', async () => {
    const id = start('mock:denied mock:monitoring keep watching');
    await waitFor(id, (r) => r?.status === 'failed');
    expect(deniedErrors(id)).toHaveLength(1);
    expect(nudges(id)).toEqual([]);
  }, 40_000);

  it('still fails a denied turn with no turn-end marker, without a nudge', async () => {
    const id = start('mock:denied just do it');
    await waitFor(id, (r) => r?.status === 'failed');
    expect(deniedErrors(id)).toHaveLength(1);
    expect(nudges(id)).toEqual([]);
  }, 40_000);
});
