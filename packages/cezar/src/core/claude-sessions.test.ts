import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeSessionSaved } from './claude-sessions.ts';

describe('claudeSessionSaved', () => {
  let configDir: string;
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'cez-claude-sessions-'));
  });
  afterEach(() => rmSync(configDir, { recursive: true, force: true }));

  it('finds a transcript in any project dir, whatever the cwd encoding', () => {
    mkdirSync(join(configDir, 'projects', '-home-a-repo'), { recursive: true });
    mkdirSync(join(configDir, 'projects', '-home-b-other'), { recursive: true });
    writeFileSync(join(configDir, 'projects', '-home-b-other', 'abc.jsonl'), '{}\n');
    expect(claudeSessionSaved(configDir, 'abc')).toBe(true);
  });

  it('answers false when the projects dir is readable and no project holds the session', () => {
    mkdirSync(join(configDir, 'projects', '-home-a-repo'), { recursive: true });
    writeFileSync(join(configDir, 'projects', '-home-a-repo', 'other.jsonl'), '{}\n');
    expect(claudeSessionSaved(configDir, 'abc')).toBe(false);
  });

  it('fails open when there is no projects dir to read', () => {
    expect(claudeSessionSaved(configDir, 'abc')).toBe(true);
    expect(claudeSessionSaved(join(configDir, 'missing'), 'abc')).toBe(true);
  });
});
