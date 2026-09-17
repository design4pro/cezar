import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { scrubInheritedRunState } from '../vitest.inherited-run-state.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK_BIN = join(HERE, '..', 'scripts', 'mock-claude.mjs');

const JOURNAL = '# Handoff — probe\n\n## Progress log\n\n- control line\n';
const FOLLOWUPS = '[]\n';

const probeDirs: string[] = [];

/** A live task's own state, as the suite would find it in the ambient environment. */
const writeProbeState = (): { dir: string; journal: string; followups: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-inherited-run-state-'));
  probeDirs.push(dir);
  const journal = join(dir, 'live-task.handoff.md');
  const followups = join(dir, 'todos.json');
  writeFileSync(journal, JOURNAL, 'utf8');
  writeFileSync(followups, FOLLOWUPS, 'utf8');
  return { dir, journal, followups };
};

/** One dry-run turn through the mock agent, on exactly the environment handed in. */
const runMockTurn = (env: NodeJS.ProcessEnv, cwd: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MOCK_BIN], {
      cwd,
      env,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', reject);
    child.on('exit', () => resolve());
    child.stdin.write(
      `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'probe turn' }] },
      })}\n`,
    );
    child.stdin.end();
  });

afterEach(() => {
  for (const dir of probeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * #4: a suite run inside a live cezar task wrote a fabricated progress entry into that
 * task's own handoff journal, and a follow-up stamped with its task id. The hazard was
 * defended at exactly one spawn site, so the next site added re-opened it; the guard
 * belongs in the test-environment seam, where it covers sites that do not exist yet.
 */
describe('inherited per-task run state', () => {
  it('is shadowed for every case in the worker, not merely absent', () => {
    // An absent key is what a clean CI machine looks like anyway — only a present,
    // empty one proves the setup module scrubbed whatever the ambient environment had.
    expect(process.env.CEZ_HANDOFF_FILE).toBe('');
    expect(process.env.CEZ_TODOS_FILE).toBe('');
  });

  it('scrubbed, leaves an inherited handoff journal and follow-ups file byte-identical', async () => {
    const probe = writeProbeState();
    const env = {
      ...process.env,
      CEZ_HANDOFF_FILE: probe.journal,
      CEZ_TODOS_FILE: probe.followups,
      CEZ_TASK_ID: 'live-task',
    };

    scrubInheritedRunState(env);
    await runMockTurn(env, probe.dir);

    expect(readFileSync(probe.journal, 'utf8')).toBe(JOURNAL);
    expect(readFileSync(probe.followups, 'utf8')).toBe(FOLLOWUPS);
  }, 30_000);

  // The positive control for the case above: the mock writing nothing at all would make
  // it pass without the scrub. Also pins what this fix deliberately did NOT change —
  // the mock's writes are the dry-run Inbox fixture and must keep working.
  it('unscrubbed, the same turn does write both', async () => {
    const probe = writeProbeState();
    const env = {
      ...process.env,
      CEZ_HANDOFF_FILE: probe.journal,
      CEZ_TODOS_FILE: probe.followups,
      CEZ_TASK_ID: 'live-task',
    };

    await runMockTurn(env, probe.dir);

    expect(readFileSync(probe.journal, 'utf8')).toContain('mock: implemented the change');
    expect(readFileSync(probe.followups, 'utf8')).toContain('"taskId": "live-task"');
  }, 30_000);

  /**
   * `src/workflows/system-prompt.test.ts` sets the follow-ups path in its own `beforeAll`
   * to simulate a nested cezar, and asserts the run machinery shadows it. Scrubbing once
   * at setup-module load leaves that intact; scrubbing around every case would overwrite
   * it between the hook and the case, and those suites would go on passing while no
   * longer testing inheritance at all. This pins the ordering that keeps them honest.
   */
  describe('a suite that sets the paths itself', () => {
    const inherited = join(tmpdir(), 'nested-cezar-todos.json');
    let saved: string | undefined;

    beforeAll(() => {
      saved = process.env.CEZ_TODOS_FILE;
      process.env.CEZ_TODOS_FILE = inherited;
    });
    afterAll(() => {
      if (saved === undefined) delete process.env.CEZ_TODOS_FILE;
      else process.env.CEZ_TODOS_FILE = saved;
    });

    it('keeps its own value inside the case — the scrub ran once, at load', () => {
      expect(process.env.CEZ_TODOS_FILE).toBe(inherited);
    });
  });
});
