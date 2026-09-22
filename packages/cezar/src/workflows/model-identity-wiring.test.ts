import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { WorkflowDef } from './types.ts';
import { RunManager } from './run.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * Wiring-level coverage for the canonical provider/model identity (#405).
 *
 * `model-identity.test.ts` pins the pure mapper; this suite pins the part the
 * PR actually ships — that the run WIRING uses it. It drives the real engine
 * under `CEZ_DRY_RUN=1` and asserts on both ends of the seam at once:
 *
 *  - the wire form the runner is handed (captured from the mock's argv via
 *    `CEZ_MOCK_ARGS_FILE`), and
 *  - the identity persisted on the record (`RunRecord.modelIdentity`).
 *
 * Those two agreeing IS the property #405 exists to guarantee: "a run record
 * can end up asserting a model that is not what actually ran" is exactly the
 * failure a green unit suite over the mapper alone would not have caught.
 */
describe('model identity wiring (dry run)', () => {
  let repoRoot: string;
  let argsFile: string;
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-model-identity-'));
    argsFile = join(repoRoot, 'mock-args.ndjson');
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    savedEnv.CEZ_MOCK_ARGS_FILE = process.env.CEZ_MOCK_ARGS_FILE;
    savedEnv.CEZ_FOLLOWUPS = process.env.CEZ_FOLLOWUPS;
    // Codex has no CEZ_DRY_RUN mock of its own, so the bundled app-server fixture stands in.
    // The step-model guard below must refuse BEFORE anything spawns; pointing the binary at the
    // fixture is what keeps a regression a failed assertion rather than a real, networked run.
    savedEnv.CEZ_CODEX_BIN = process.env.CEZ_CODEX_BIN;
    process.env.CEZ_CODEX_BIN = fileURLToPath(
      new URL('../core/__fixtures__/codex/mock-codex-app-server.mjs', import.meta.url),
    );
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_MOCK_ARGS_FILE = argsFile;
    delete process.env.CEZ_FOLLOWUPS;
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), JSON.stringify({ maxParallel: 1 }), 'utf8');
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  // Agent step + trailing check, so the agent session auto-ends and the run
  // reaches a terminal status instead of parking at `waiting`.
  const workflow: WorkflowDef = {
    name: 'model-identity-test',
    source: 'built-in',
    steps: [
      { id: 'work', prompt: '{{task}}' },
      { id: 'verify', command: 'true' },
    ],
  };

  const TERMINAL = new Set(['done', 'review', 'failed', 'cancelled']);

  async function settle(runId: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (!TERMINAL.has(store.getRun(runId)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async function runToEnd(input: { task: string; model?: string }): Promise<string> {
    writeFileSync(argsFile, '', 'utf8'); // fresh capture per run
    const record = manager.startRun(workflow, input);
    await settle(record.id);
    return record.id;
  }

  /** The `--model` value the mock was actually invoked with, or undefined when unset. */
  function capturedModel(index = 0): string | undefined {
    const lines = readFileSync(argsFile, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThan(index);
    const argv = JSON.parse(lines[index] as string) as string[];
    const idx = argv.indexOf('--model');
    return idx < 0 ? undefined : argv[idx + 1];
  }

  it('a bare preset reaches the CLI bare and persists provider-qualified', async () => {
    const id = await runToEnd({ task: 'do the thing', model: 'opus' });
    // The wire form the claude CLI wants is the bare alias …
    expect(capturedModel()).toBe('opus');
    // … while the record carries the canonical identity (#405's whole point).
    expect(store.getRun(id)?.modelIdentity).toBe('anthropic/opus');
    expect(store.getRun(id)?.model).toBe('opus'); // the free-text surface is untouched
  }, 30_000);

  it('an auto (empty) model persists no identity and pins nothing on the wire', async () => {
    const id = await runToEnd({ task: 'do the thing' });
    expect(capturedModel()).toBeUndefined();
    expect(store.getRun(id)?.modelIdentity).toBeUndefined();
  }, 30_000);

  it('a provider-qualified model is normalised to the bare wire form for claude', async () => {
    // `anthropic/claude-opus-4-1` is deliberately NOT one of opencode's known
    // presets, so `continueRun`'s foreign-pin guard leaves it on the record and
    // the continuation below exercises the normaliser rather than a cleared pin.
    const id = await runToEnd({ task: 'do the thing', model: 'anthropic/claude-opus-4-1' });
    expect(capturedModel()).toBe('claude-opus-4-1');
    expect(store.getRun(id)?.modelIdentity).toBe('anthropic/claude-opus-4-1');
  }, 30_000);

  it('a continuation normalises the same way as the first spawn (#405 review M1)', async () => {
    const id = await runToEnd({ task: 'do the thing', model: 'anthropic/claude-opus-4-1' });
    expect(capturedModel(0)).toBe('claude-opus-4-1');

    expect(manager.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
    const deadline = Date.now() + 20_000;
    while (readFileSync(argsFile, 'utf8').trim().split('\n').length < 2) {
      if (Date.now() > deadline) throw new Error('continuation did not start in time');
      await new Promise((r) => setTimeout(r, 100));
    }
    // The continuation reads `model` off the record — the RAW free-text string.
    // Without the normaliser it would hand the CLI `anthropic/claude-opus-4-1`,
    // a wire form the first step already converted away: same run, two models.
    expect(capturedModel(1)).toBe('claude-opus-4-1');
    // A resumed session has no wall clock and parks at `waiting`, so this
    // asserts the record directly — the identity is written before the spawn.
    expect(store.getRun(id)?.modelIdentity).toBe('anthropic/claude-opus-4-1');
  }, 40_000);

  it('a follow-up model override re-writes the persisted identity (#401 + #405)', async () => {
    const id = await runToEnd({ task: 'do the thing', model: 'opus' });
    expect(store.getRun(id)?.modelIdentity).toBe('anthropic/opus');

    // #401 lets a continuation switch the model. The record must follow what
    // actually ran, not keep asserting the model the run STARTED with.
    expect(manager.continueRun(id, { text: 'keep going', model: 'haiku' })).toEqual({ ok: true });
    const deadline = Date.now() + 20_000;
    while (readFileSync(argsFile, 'utf8').trim().split('\n').length < 2) {
      if (Date.now() > deadline) throw new Error('continuation did not start in time');
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(capturedModel(1)).toBe('haiku');
    // The record now asserts what the continuation ran, not what the run started with.
    expect(store.getRun(id)?.modelIdentity).toBe('anthropic/haiku');
  }, 40_000);

  it('Claude gateway models run with their provider-qualified wire id', async () => {
    const id = await runToEnd({ task: 'do the thing', model: 'deepseek/deepseek-v4-flash' });
    const record = store.getRun(id);
    expect(record?.status).toBe('done');
    expect(record?.modelIdentity).toBe('deepseek/deepseek-v4-flash');
    expect(capturedModel(0)).toBe('deepseek/deepseek-v4-flash');
  }, 30_000);

  it('fails a run when the runner reports a model error instead of parking it as active', async () => {
    const id = await runToEnd({ task: 'mock:auth-error' });
    const record = store.getRun(id);
    expect(record?.status).toBe('failed');
    expect(record?.error).toContain('Failed to authenticate');
    expect(record?.steps.find((step) => step.id === 'work')?.status).toBe('failed');
  }, 30_000);

  /**
   * A workflow step pins `model: opus` because the workflow was written for Claude. Run the same
   * workflow on codex and that pin — which wins over the model the composer picked — reached the
   * codex app-server verbatim. Codex accepts the thread, then the API refuses the request, and
   * the turn ends having done nothing. The pairing guard already knew `opus` is not a codex
   * model (`model-presets.ts`); nothing on the step path had ever asked it.
   */
  it("refuses a step model written for another runner before anything spawns", async () => {
    const pinned: WorkflowDef = {
      name: 'foreign-step-model',
      source: 'built-in',
      steps: [
        { id: 'work', prompt: '{{task}}', model: 'opus' },
        { id: 'verify', command: 'true' },
      ],
    };
    writeFileSync(argsFile, '', 'utf8');
    const record = manager.startRun(pinned, {
      task: 'do the thing',
      runner: 'codex',
      model: 'gpt-5.1-codex',
    });
    await settle(record.id);

    const stored = store.getRun(record.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.error).toContain("model 'opus' is not a codex model");
    // The message has to name where the pin lives, or the reader has nowhere to go.
    expect(stored?.error).toContain('step "work"');
    expect(stored?.steps.find((step) => step.id === 'work')?.status).toBe('failed');
  }, 30_000);

  it('leaves a step model the runner does serve alone', async () => {
    const pinned: WorkflowDef = {
      name: 'native-step-model',
      source: 'built-in',
      steps: [
        { id: 'work', prompt: '{{task}}', model: 'haiku' },
        { id: 'verify', command: 'true' },
      ],
    };
    writeFileSync(argsFile, '', 'utf8');
    const record = manager.startRun(pinned, { task: 'do the thing', model: 'opus' });
    await settle(record.id);

    expect(store.getRun(record.id)?.status).toBe('done');
    // The step's pin still wins over the task-level model — this fix narrows nothing.
    expect(capturedModel()).toBe('haiku');
    expect(store.getRun(record.id)?.modelIdentity).toBe('anthropic/haiku');
  }, 30_000);

  it('a continuation with an unsupported Codex provider still fails loudly', async () => {
    const id = await runToEnd({ task: 'do the thing', model: 'opus' });
    expect(store.getRun(id)?.modelIdentity).toBe('anthropic/opus');

    expect(
      manager.continueRun(id, {
        text: 'keep going',
        runner: 'codex',
        model: 'anthropic/claude-opus-4-8',
      }),
    ).toEqual({ ok: false, error: "model 'anthropic/claude-opus-4-8' is not a codex model" });
  }, 40_000);
});
