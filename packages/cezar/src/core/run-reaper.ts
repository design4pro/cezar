/**
 * Terminal-transition cleanup for the processes a run's agent left running.
 *
 * An agent's Bash starts things that outlive the CLI: a `wrangler dev`, the
 * `workerd` a vitest pool spawns, a dev server it forgot to stop. When the CLI
 * exits they are reparented away from it, so neither `child.kill` nor the
 * process-usage tree walk (which starts at the CLI's pid) can see them any
 * more. On the cockpit host of 2026-09-24/25, fifteen such `workerd`
 * processes from long-settled runs held ~3.7 GB of a 7.7 GB machine, and the
 * OOM killer took `pnpm install` out of every later run's bootstrap.
 *
 * The handle that survives reparenting — and `setsid`, and a detached spawn —
 * is the environment: every process an agent starts inherits the
 * `CEZ_TASK_ID=<runId>` that `agentEnv` hands the CLI. So the reaper matches
 * on that, not on a pid tree or a process group.
 *
 * Linux only (it reads `/proc/<pid>/environ`); elsewhere it finds nothing and
 * the run settles exactly as before. Processes of other users are unreadable
 * and skipped.
 */

import { readdirSync, readFileSync } from 'node:fs';

/** How long a SIGTERM'd process gets before the SIGKILL pass. */
export const REAP_GRACE_MS = 5_000;

/** Pids whose environment carries exactly `CEZ_TASK_ID=<runId>`, never this process. */
export function findRunProcesses(runId: string): number[] {
  if (process.platform !== 'linux') return [];
  const marker = `CEZ_TASK_ID=${runId}`;
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    let environ: string;
    try {
      environ = readFileSync(`/proc/${name}/environ`, 'latin1');
    } catch {
      continue; // exited mid-scan, or another user's process
    }
    if (environ.split('\0').includes(marker)) pids.push(pid);
  }
  return pids;
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // already gone
  }
}

/**
 * SIGTERM every process still carrying the run's marker, then SIGKILL what is
 * left after `graceMs`. The SIGKILL pass re-scans instead of reusing the pid
 * list, so a pid recycled in between is never hit. Returns the SIGTERM'd pids.
 */
export function reapRunProcesses(runId: string, graceMs = REAP_GRACE_MS): number[] {
  const pids = findRunProcesses(runId);
  for (const pid of pids) signal(pid, 'SIGTERM');
  if (pids.length > 0) {
    const timer = setTimeout(() => {
      for (const pid of findRunProcesses(runId)) signal(pid, 'SIGKILL');
    }, graceMs);
    timer.unref?.();
  }
  return pids;
}
