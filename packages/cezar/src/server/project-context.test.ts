import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationStore } from '../automations/store.ts';
import { emitUsageForTest } from '../core/process-usage.ts';
import { createWorktree } from '../git-worktree.ts';
import { ProjectContextError, ProjectContexts, type ProjectContextSource } from './project-context.ts';

/**
 * Lazy per-project context map (spec 2026-07-20-multi-project-workspace,
 * step 2.1): nothing instantiated until first access, one instance per id,
 * missing roots never built, and a disposed context's manager stops
 * receiving usage-sampler ticks. The registry is injected as a plain
 * `listProjects` resolver so nothing here touches `~/.cezar`.
 */
describe('ProjectContexts', () => {
  let rootA: string;
  let rootB: string;

  beforeEach(() => {
    rootA = mkdtempSync(join(tmpdir(), 'cez-ctx-a-'));
    rootB = mkdtempSync(join(tmpdir(), 'cez-ctx-b-'));
  });

  afterEach(() => {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  });

  function makeContexts(projects: ProjectContextSource[]): ProjectContexts {
    return new ProjectContexts({ listProjects: async () => projects });
  }

  it('shutdown waits for opened and still-building projects, then prevents new contexts', async () => {
    let releaseRegistry!: () => void;
    let delayRegistry = false;
    const contexts = new ProjectContexts({listProjects: async () => {
      if (delayRegistry) await new Promise<void>(resolve => { releaseRegistry = resolve; });
      return [{id: 'a', root: rootA, status: 'not-git'}, {id: 'b', root: rootB, status: 'not-git'}];
    }});
    const first = await contexts.context('a');
    let finishDrain!: () => void;
    const drain = vi.spyOn(first.manager.lifecycle, 'shutdown').mockImplementation(() => new Promise<void>(resolve => { finishDrain = resolve; }));
    const dispose = vi.spyOn(first.manager, 'dispose');
    delayRegistry = true;
    const building = contexts.context('b');
    const stopping = contexts.shutdownAll();
    expect(contexts.shutdownAll()).toBe(stopping);
    expect(drain).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
    await expect(contexts.context('a')).rejects.toThrow('shutting down');
    releaseRegistry();
    const second = await building;
    const secondDrain = vi.spyOn(second.manager.lifecycle, 'shutdown');
    finishDrain();
    await stopping;
    expect(secondDrain).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(contexts.ids()).toEqual([]);
  });

  it('builds lazily: nothing on construction, first access builds, second returns the same instance', async () => {
    const contexts = makeContexts([
      { id: 'a', root: rootA, status: 'not-git' },
      { id: 'b', root: rootB, status: 'not-git' },
    ]);

    // Construction instantiated nothing — no store dir, no launch-key.
    expect(existsSync(join(rootA, '.ai/cezar'))).toBe(false);
    expect(existsSync(join(rootB, '.ai/cezar'))).toBe(false);
    expect(contexts.ids()).toEqual([]);

    const first = await contexts.context('a');
    expect(first.id).toBe('a');
    expect(first.dataDir).toBe(join(rootA, '.ai/cezar'));
    expect(first.launchKey).not.toBe('');
    expect(existsSync(join(rootA, '.ai/cezar', 'launch-key'))).toBe(true);
    // Only the accessed project was built.
    expect(existsSync(join(rootB, '.ai/cezar'))).toBe(false);
    expect(contexts.ids()).toEqual(['a']);

    const second = await contexts.context('a');
    expect(second).toBe(first);
  });

  it('dedupes concurrent builds of the same project into one instance', async () => {
    const contexts = makeContexts([{ id: 'a', root: rootA, status: 'not-git' }]);
    const [one, two] = await Promise.all([contexts.context('a'), contexts.context('a')]);
    expect(one).toBe(two);
  });

  it('uses the injected coordinator-owned automation store', async () => {
    const automationStore = AutomationStore.open(join(rootA, '.ai/cezar'));
    const resolveAutomationStore = vi.fn(() => automationStore);
    const contexts = new ProjectContexts({
      listProjects: async () => [{ id: 'a', root: rootA, status: 'not-git' }],
      automationStore: resolveAutomationStore,
    });
    const context = await contexts.context('a');
    expect(context.automationStore).toBe(automationStore);
    expect(resolveAutomationStore).toHaveBeenCalledWith('a', rootA);
    contexts.disposeAll();
  });

  it('never instantiates a missing-root project (even when the directory happens to exist)', async () => {
    const contexts = makeContexts([{ id: 'gone', root: rootA, status: 'missing' }]);
    await expect(contexts.context('gone')).rejects.toMatchObject({
      name: 'ProjectContextError',
      reason: 'missing-root',
      projectId: 'gone',
    });
    // Not built, and nothing written under the root.
    expect(contexts.peek('gone')).toBeUndefined();
    expect(existsSync(join(rootA, '.ai/cezar'))).toBe(false);
  });

  it('throws unknown-project for an id the registry does not hold', async () => {
    const contexts = makeContexts([{ id: 'a', root: rootA, status: 'not-git' }]);
    await expect(contexts.context('nope')).rejects.toMatchObject({
      name: 'ProjectContextError',
      reason: 'unknown-project',
      projectId: 'nope',
    });
    expect(contexts.ids()).toEqual([]);
  });

  it('exposes the failure as a typed error instance', async () => {
    const contexts = makeContexts([]);
    const err = await contexts.context('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectContextError);
  });

  it('dispose(): the manager receives no further usage ticks and the index is flushed', async () => {
    const contexts = makeContexts([{ id: 'a', root: rootA, status: 'not-git' }]);
    const ctx = await contexts.context('a');
    // The constructor's onUsage listener calls `this.enforceMemoryLimit` —
    // spy on the instance and drive the fan-out directly, the way the shared
    // `ps` sampler would. An empty snapshot keeps the real method a sync no-op.
    const spy = vi.spyOn(
      ctx.manager as unknown as { enforceMemoryLimit: (s: Record<string, never>) => Promise<void> },
      'enforceMemoryLimit',
    );

    emitUsageForTest({});
    expect(spy).toHaveBeenCalledTimes(1);

    expect(contexts.dispose('a')).toBe(true);
    emitUsageForTest({});
    expect(spy).toHaveBeenCalledTimes(1); // unsubscribed — no further ticks
    // Store closed: the index landed on disk despite the debounced save.
    expect(existsSync(join(rootA, '.ai/cezar', 'runs.json'))).toBe(true);
    expect(ctx.store.listenerCount('event')).toBe(0);

    // Disposed id is gone from the map; the next access builds a fresh context.
    expect(contexts.peek('a')).toBeUndefined();
    const rebuilt = await contexts.context('a');
    expect(rebuilt).not.toBe(ctx);
    contexts.dispose('a');
  });

  it('onContextBuilt: fires once per build (not cached hits), unsubscribes cleanly, and a throwing listener never fails the build', async () => {
    const contexts = makeContexts([
      { id: 'a', root: rootA, status: 'not-git' },
      { id: 'b', root: rootB, status: 'not-git' },
    ]);
    const built: string[] = [];
    const off = contexts.onContextBuilt((ctx) => built.push(ctx.id));
    contexts.onContextBuilt(() => {
      throw new Error('subscriber boom');
    });

    await contexts.context('a');
    expect(built).toEqual(['a']); // the throwing listener didn't fail the build
    await contexts.context('a');
    expect(built).toEqual(['a']); // cached hit — no re-notify

    off();
    const b = await contexts.context('b');
    expect(b.id).toBe('b'); // built fine with only the throwing listener left
    expect(built).toEqual(['a']); // unsubscribed — not notified for b
    contexts.disposeAll();
  });

  it('dispose() of a never-built project is a no-op returning false', () => {
    const contexts = makeContexts([{ id: 'a', root: rootA, status: 'not-git' }]);
    expect(contexts.dispose('a')).toBe(false);
  });

  it('disposeAll() tears down every built context', async () => {
    const contexts = makeContexts([
      { id: 'a', root: rootA, status: 'not-git' },
      { id: 'b', root: rootB, status: 'not-git' },
    ]);
    const a = await contexts.context('a');
    const b = await contexts.context('b');
    const spyA = vi.spyOn(
      a.manager as unknown as { enforceMemoryLimit: (s: Record<string, never>) => Promise<void> },
      'enforceMemoryLimit',
    );
    const spyB = vi.spyOn(
      b.manager as unknown as { enforceMemoryLimit: (s: Record<string, never>) => Promise<void> },
      'enforceMemoryLimit',
    );

    contexts.disposeAll();
    expect(contexts.ids()).toEqual([]);
    emitUsageForTest({});
    expect(spyA).not.toHaveBeenCalled();
    expect(spyB).not.toHaveBeenCalled();
  });
});

/** The startup orphan sweep deleted every task's worktree and branch whenever runs.json could
 *  not be loaded: the index read as empty, so every worktree looked like an orphan. */
describe('ProjectContexts — orphan sweep over an unreadable index', () => {
  const GIT = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
  let root: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-ctx-orphans-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    writeFileSync(join(root, 'base.txt'), 'base\n');
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', [...GIT, 'commit', '-q', '-m', 'base'], { cwd: root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });

  async function taskWorktree(runId: string, withEvents: boolean): Promise<{ path: string; branch: string }> {
    const wt = await createWorktree(root, runId, 'main');
    writeFileSync(join(wt.path, 'unsaved.txt'), 'agent work not yet committed\n');
    if (withEvents) {
      mkdirSync(join(root, '.ai/cezar/runs'), { recursive: true });
      writeFileSync(join(root, '.ai/cezar/runs', `${runId}.ndjson`), '{"seq":1,"type":"note","message":"x"}\n');
    }
    return { path: wt.path, branch: wt.branch };
  }

  it('keeps the worktree and branch of a run the index lost but whose events are on disk', async () => {
    const runId = '22222222-2222-4222-8222-222222222222';
    const { path, branch } = await taskWorktree(runId, true);
    writeFileSync(join(root, '.ai/cezar/runs.json'), '[{"id": "hand-edited",}]');

    await new ProjectContexts({ listProjects: async () => [{ id: 'p', root, status: 'ok' }] }).context('p');

    expect(existsSync(join(path, 'unsaved.txt'))).toBe(true);
    expect(() => execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: root })).not.toThrow();
  });

  it('still sweeps a real orphan — no record and no event file', async () => {
    const { path } = await taskWorktree('33333333-3333-4333-8333-333333333333', false);

    await new ProjectContexts({ listProjects: async () => [{ id: 'p', root, status: 'ok' }] }).context('p');

    expect(existsSync(path)).toBe(false);
  });
});
