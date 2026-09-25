import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { findRunProcesses, reapRunProcesses } from './run-reaper.ts';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
};

/** A long-lived process in its own session (setsid), the way a detached dev server escapes. */
const startDetached = (env: Record<string, string>, ignoreTerm = false): ChildProcess => {
  const script = ignoreTerm ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)" : 'setInterval(() => {}, 1000)';
  const child = spawn(process.execPath, ['-e', script], { env: { ...process.env, ...env }, detached: true, stdio: 'ignore' });
  child.unref();
  return child;
};

describe.runIf(process.platform === 'linux')('run-reaper', () => {
  const started: ChildProcess[] = [];
  afterEach(() => {
    for (const child of started.splice(0)) if (child.pid && alive(child.pid)) process.kill(child.pid, 'SIGKILL');
  });

  it('stops a detached process that carries the run id, and leaves other runs alone', async () => {
    const mine = startDetached({ CEZ_TASK_ID: 'run-reaper-a' });
    const other = startDetached({ CEZ_TASK_ID: 'run-reaper-b' });
    started.push(mine, other);

    expect(await waitFor(() => findRunProcesses('run-reaper-a').includes(mine.pid as number))).toBe(true);
    const reaped = reapRunProcesses('run-reaper-a');

    expect(reaped).toContain(mine.pid);
    expect(reaped).not.toContain(other.pid);
    expect(await waitFor(() => !alive(mine.pid as number))).toBe(true);
    expect(alive(other.pid as number)).toBe(true);
  });

  it('matches the whole value, so one run id never reaps a run whose id it prefixes', async () => {
    const longer = startDetached({ CEZ_TASK_ID: 'run-reaper-c-2' });
    started.push(longer);
    expect(await waitFor(() => findRunProcesses('run-reaper-c-2').length > 0)).toBe(true);

    expect(findRunProcesses('run-reaper-c')).toEqual([]);
  });

  it('SIGKILLs a process that ignores SIGTERM once the grace period is over', async () => {
    const stubborn = startDetached({ CEZ_TASK_ID: 'run-reaper-d' }, true);
    started.push(stubborn);
    expect(await waitFor(() => findRunProcesses('run-reaper-d').length > 0)).toBe(true);
    // Let the child install its SIGTERM handler before it is signalled.
    await new Promise((resolve) => setTimeout(resolve, 300));

    reapRunProcesses('run-reaper-d', 100);

    expect(await waitFor(() => !alive(stubborn.pid as number))).toBe(true);
  });

  it('never matches the calling process', () => {
    expect(findRunProcesses(process.env.CEZ_TASK_ID ?? '__no_task__')).not.toContain(process.pid);
  });
});
