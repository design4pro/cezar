import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCliRunner, protectedWritePreflight } from './claude-cli-runner.ts';
import type { AgentEvent } from './agent-runner.ts';

describe('protected configuration permission boundary', () => {
  it('uses declared paths and keeps supervision scoped to the current worktree', () => {
    expect(protectedWritePreflight({ cwd: '/work/one', userPrompt: 'read .claude', writePaths: ['src/app.ts'] }).status).toBe('eligible');
    expect(protectedWritePreflight({ cwd: '/work/one', userPrompt: 'edit config', writePaths: ['./.claude/settings.json'] })).toEqual({
      status: 'requires-supervision', paths: ['./.claude/settings.json'], worktree: '/work/one',
    });
    expect(protectedWritePreflight({ cwd: '/work/one', userPrompt: 'edit', writePaths: ['.//.claude/settings.json'] }).status).toBe('requires-supervision');
    const runner = new ClaudeCliRunner({ bin: '/never-spawn-this' });
    expect(() => runner.startSession({ cwd: '/work/one', userPrompt: 'edit', writePaths: ['.claude/hooks/guard.sh'] })).toThrow('Permission preflight');
  });

  it('reports one refusal and ends without a turn-end that could trigger another nudge', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cezar-permission-'));
    const bin = join(cwd, 'denied.mjs');
    writeFileSync(bin, `#!/usr/bin/env node
process.stdin.once('data', () => {
  console.log(JSON.stringify({ type: 'result', subtype: 'success', permission_denials: [{ tool_name: 'Edit', tool_input: { file_path: '.claude/settings.json' } }] }));
});
`);
    chmodSync(bin, 0o755);
    try {
      const events: AgentEvent[] = [];
      const runner = new ClaudeCliRunner({ bin, timeoutMs: 5000 });
      await runner.run({ cwd, userPrompt: 'edit protected config' }, (event) => events.push(event));
      const errors = events.filter((event) => event.type === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ message: expect.stringContaining('supervised session') });
      expect(events.some((event) => event.type === 'turn-end')).toBe(false);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
