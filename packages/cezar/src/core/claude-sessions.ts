import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Whether Claude Code saved this session, so `claude --resume <sessionId>` can find it. The CLI
 * keeps one transcript per session at `<configDir>/projects/<encoded cwd>/<sessionId>.jsonl`; a
 * CLI killed before its first turn saved nothing, and resuming that id exits with "No conversation
 * found with session ID". Every project dir is searched, so the cwd encoding stays the CLI's own.
 *
 * Fails open: an unreadable `projects` dir answers true, so a layout cezar does not recognise
 * keeps resuming exactly as before.
 */
export function claudeSessionSaved(configDir: string, sessionId: string): boolean {
  const projectsDir = join(configDir, 'projects');
  let projects: string[];
  try {
    projects = readdirSync(projectsDir);
  } catch {
    return true;
  }
  return projects.some((project) => existsSync(join(projectsDir, project, `${sessionId}.jsonl`)));
}
