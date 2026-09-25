import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const MOCK_CLAUDE = fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url));

/**
 * A claude session the CLI never saved cannot be resumed. On 2026-09-24 two planned.travel runs
 * (fc3a417b, bdb270cb) were restarted before their first session produced a single event; the
 * restart's `claude --resume <id>` exited "No conversation found with session ID" and the runs
 * failed. The continuation now starts a fresh session under a new id, with the run's context.
 *
 * Not `CEZ_DRY_RUN`: the check is skipped under it (the mock saves no transcripts), so the mock
 * runs through `CEZ_CLAUDE_BIN`, and `CLAUDE_CONFIG_DIR` points the check at a sandbox.
 */
describe('continuing a claude session the CLI never saved', () => {
  let repoRoot: string;
  let configDir: string;
  let stdinFile: string;
  let store: RunStore;
  let manager: RunManager;
  let currentId: string | undefined;
  const KEYS = ['CEZ_DRY_RUN', 'CEZ_CLAUDE_BIN', 'CLAUDE_CONFIG_DIR', 'CEZ_MOCK_STDIN_FILE'] as const;
  const saved: Partial<Record<(typeof KEYS)[number], string>> = {};
  const SINGLE_STEP: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };

  beforeEach(async () => {
    for (const key of KEYS) saved[key] = process.env[key];
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-unsaved-'));
    configDir = mkdtempSync(join(tmpdir(), 'cez-unsaved-claude-'));
    mkdirSync(join(configDir, 'projects', '-some-project'), { recursive: true });
    stdinFile = join(configDir, 'stdin.ndjson');
    delete process.env.CEZ_DRY_RUN;
    process.env.CEZ_CLAUDE_BIN = MOCK_CLAUDE;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    process.env.CEZ_MOCK_STDIN_FILE = stdinFile;
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
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  const waitFor = async (id: string, pred: (r: RunRecord | undefined) => boolean, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!pred(store.getRun(id))) {
      if (Date.now() > deadline) throw new Error(`condition not met in time (status ${store.getRun(id)?.status})`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const unsavedNotes = (id: string) => {
    const path = join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; message?: string })
      .filter((e) => e.type === 'note' && String(e.message).startsWith('claude never saved session'));
  };
  const lastPrompt = (): string => {
    const lines = readFileSync(stdinFile, 'utf8').trim().split('\n');
    return (JSON.parse(lines[lines.length - 1] ?? '{}') as { userText: string }).userText;
  };

  /** A finished first session, then a Continue on it. */
  const continueAfterFirstSession = async (): Promise<{ id: string; firstSessionId: string }> => {
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:done first pass', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'done' || r?.status === 'review' || r?.status === 'failed');
    const firstSessionId = store.getRun(record.id)?.steps[0]?.sessionId;
    expect(firstSessionId).toBeTruthy();
    return { id: record.id, firstSessionId: String(firstSessionId) };
  };

  it('starts a fresh session with the run context instead of resuming one that was never saved', async () => {
    const { id, firstSessionId } = await continueAfterFirstSession();
    expect(manager.continueRun(id, { text: 'mock:done carry on' })).toEqual({ ok: true });
    await waitFor(id, (r) => r?.steps[1]?.status === 'done' || r?.steps[1]?.status === 'failed');

    const continued = store.getRun(id)?.steps[1];
    expect(continued?.status).not.toBe('failed');
    expect(continued?.sessionId).toBeTruthy();
    expect(continued?.sessionId).not.toBe(firstSessionId);
    expect(unsavedNotes(id)).toHaveLength(1);
    expect(lastPrompt()).toContain('## New user instruction');
  }, 40_000);

  it('still resumes a session claude saved (unchanged)', async () => {
    const { id, firstSessionId } = await continueAfterFirstSession();
    writeFileSync(join(configDir, 'projects', '-some-project', `${firstSessionId}.jsonl`), '{}\n');
    expect(manager.continueRun(id, { text: 'mock:done carry on' })).toEqual({ ok: true });
    await waitFor(id, (r) => r?.steps[1]?.status === 'done' || r?.steps[1]?.status === 'failed');

    expect(store.getRun(id)?.steps[1]?.sessionId).toBe(firstSessionId);
    expect(unsavedNotes(id)).toEqual([]);
    expect(lastPrompt()).not.toContain('## New user instruction');
  }, 40_000);
});
