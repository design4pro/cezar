import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunStore } from '../runs/store.ts';
import { registerProject } from '../workspace/projects.ts';
import { RunManager } from './run.ts';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Wiring for `run-reaper.ts`: the terminal funnel (`dropActive`) must stop what a run left
 * running. Driven at that seam, like the TMPDIR cleanup it sits next to, because every
 * terminal path (done, review, failed, cancelled) reaches it.
 */
describe.runIf(process.platform === 'linux')('RunManager — reaping a settled run’s leftover processes', () => {
  const savedHome = process.env.CEZ_HOME;
  let home: string;
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const pids: number[] = [];

  beforeEach(async () => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-reaper-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-reaper-repo-'));
    process.env.CEZ_HOME = home;
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
    await registerProject(repoRoot);
  });

  afterEach(() => {
    for (const pid of pids.splice(0)) if (alive(pid)) process.kill(pid, 'SIGKILL');
    store.flush();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
  });

  it('stops a detached process carrying the run’s CEZ_TASK_ID when the run settles', async () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [{ id: 's', name: 's', kind: 'agent' }] });
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      env: { ...process.env, CEZ_TASK_ID: run.id },
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    const pid = child.pid as number;
    pids.push(pid);
    await new Promise((resolve) => setTimeout(resolve, 200));

    (manager as unknown as { dropActive(runId: string): void }).dropActive(run.id);

    const deadline = Date.now() + 5_000;
    while (alive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(alive(pid)).toBe(false);
    const notes = store.readEvents(run.id).filter((e) => e.type === 'note').map((e) => (e as { message?: string }).message);
    expect(notes.some((m) => m?.includes(`pid ${pid}`))).toBe(true);
  });
});
