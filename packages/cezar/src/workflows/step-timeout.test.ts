import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { workflowStepSchema, type WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

const captured = vi.hoisted(() => ({ specs: [] as AgentRunSpec[] }));

// A capture stub: what matters is the `timeoutMs` the engine puts into each step's spec. Every
// runner already prefers `spec.timeoutMs` over its own default (`DEFAULT_RUN_TIMEOUT_MS`).
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    backend: 'claude' as const,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void) => {
      captured.specs.push(spec);
      const sessionId = `sess-${captured.specs.length}`;
      return {
        result: new Promise<AgentRunResult>((resolve) => {
          setTimeout(() => {
            onEvent?.({ type: 'session', sessionId });
            resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 });
          }, 0);
        }),
        sendMessage: () => false,
        end: () => {},
        interrupt: () => {},
        open: false,
      };
    },
    interrupt: async () => {},
  }),
}));

// planned.travel 2026-10-20..23: 48 of 95 `implement` steps were killed at the fixed 30 min, and
// the free-form Continue that followed skipped the chain's own gate, PR and attestation steps.
describe('a workflow step sets its own wall clock', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;

  beforeEach(async () => {
    captured.specs.length = 0;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-step-timeout-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(repoRoot, 'claude-home'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    manager?.dispose();
    manager = undefined;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('passes timeoutMinutes to the session, and leaves a step without it on the runner default', async () => {
    const def: WorkflowDef = {
      name: 'timed',
      source: 'file',
      steps: [
        { id: 'implement', name: 'Implement', prompt: '{{task}}', timeoutMinutes: 90 },
        { id: 'pr', name: 'PR', prompt: 'open it' },
        { id: 'last', name: 'Last', prompt: 'merge it', timeoutMinutes: 5 },
      ],
    };
    const record = manager!.startRun(def, { task: 'do the thing', worktree: false, runner: 'claude' });
    await expect.poll(() => captured.specs.length, { timeout: 15_000 }).toBe(3);
    await expect
      .poll(() => store.getRun(record.id)?.status, { timeout: 15_000 })
      .toSatisfy((status) => ['done', 'review', 'failed', 'cancelled'].includes(String(status)));

    expect(captured.specs.map((spec) => spec.timeoutMs)).toEqual([90 * 60_000, undefined, 0]);
  });

  it('refuses timeoutMinutes on a check step and anything but a positive integer', () => {
    expect(workflowStepSchema.safeParse({ id: 'a', prompt: 'x', timeoutMinutes: 90 }).success).toBe(true);
    expect(workflowStepSchema.safeParse({ id: 'a', command: 'true', timeoutMinutes: 90 }).success).toBe(false);
    expect(workflowStepSchema.safeParse({ id: 'a', prompt: 'x', timeoutMinutes: 0 }).success).toBe(false);
    expect(workflowStepSchema.safeParse({ id: 'a', prompt: 'x', timeoutMinutes: 1.5 }).success).toBe(false);
  });
});
