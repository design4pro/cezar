#!/usr/bin/env node
// One-command rebuild (`npm run rebuild`): compile THIS checkout and restart the
// launchd cockpit service, so the daemon on the fixed port serves the code that
// is checked out here rather than whatever it loaded at boot.
//
// It sits at the repo root for the same reason `dev.mjs` does: it spans every
// workspace (the root's own `build` forwards into all four) and it owns a
// machine-level concern — the `dev.cezar.cockpit` launchd job — that no single
// package should reach for. The build itself is not reimplemented here; it is
// the root `build` script, so the packages keep owning how they compile.
//
// THE STEP ORDER IS THE POINT. The build runs while the old cockpit keeps
// serving, and only a build that exited zero is allowed to restart it. Stopping
// the service first is what goes wrong in practice: the job is `KeepAlive`, so
// launchd resurrects it within seconds — straight onto a half-written `dist/`.
// A restart afterwards is a sub-second gap instead, with no window in which a
// running process can pick up a partial compile.
//
// Guards abort BEFORE the build, never between build and restart, so a refusal
// always leaves the machine exactly as it was found. `--force` skips them.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = 'dev.cezar.cockpit';
const PLIST = path.join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const BRANCH = 'design4pro';
// A run in any of these states is doing work a restart would destroy.
const LIVE = new Set(['running', 'queued', 'review', 'monitoring']);

const args = new Set(process.argv.slice(2));
const force = args.has('--force');
const buildOnly = args.has('--build-only');

const die = (msg, hint) => {
  console.error(`\n  ✗ ${msg}`);
  if (hint) console.error(`    ${hint}`);
  process.exit(1);
};
const sh = (cmd, argv, opts = {}) =>
  spawnSync(cmd, argv, { cwd: repoRoot, encoding: 'utf8', ...opts });
const out = (cmd, argv) => (sh(cmd, argv).stdout ?? '').trim();

// ---- guards -----------------------------------------------------------------

const branch = out('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== BRANCH && !force) {
  die(`checkout is on '${branch}', not '${BRANCH}'`, `switch it, or re-run with --force to build '${branch}' anyway.`);
}

// Only `packages/` matters: that is what compiles into the artifact the service
// runs. Untracked junk elsewhere in the tree is none of this script's business.
const dirty = out('git', ['status', '--porcelain', '--', 'packages']);
if (dirty && !force) {
  die('uncommitted changes under packages/', `the daemon would end up pinned to unreviewed code:\n${dirty}\n    Commit or stash them, or re-run with --force.`);
}

// Every registered project, not just this one: the cockpit is shared, so a
// restart interrupts work in repos this checkout knows nothing about. Skipped
// under --build-only, which restarts nothing and so can kill no run.
if (!force && !buildOnly) {
  const live = [];
  try {
    const registry = JSON.parse(readFileSync(path.join(homedir(), '.cezar', 'config.json'), 'utf8'));
    for (const project of registry.projects ?? []) {
      try {
        const store = JSON.parse(readFileSync(path.join(project.root, '.ai', 'cezar', 'runs.json'), 'utf8'));
        for (const run of Array.isArray(store) ? store : (store.runs ?? [])) {
          if (LIVE.has(run.status)) live.push(`${project.id}: ${String(run.id).slice(0, 8)} (${run.status})`);
        }
      } catch {} // a project with no runs yet, or an unreadable store, blocks nothing
    }
  } catch {} // no registry means no other project to protect
  if (live.length) {
    die(`${live.length} run(s) still in flight`, `a restart kills them:\n      ${live.join('\n      ')}\n    Wait, or re-run with --force.`);
  }
}

// ---- build ------------------------------------------------------------------

console.log(`\n  building ${branch} @ ${out('git', ['rev-parse', '--short', 'HEAD'])} …\n`);
const build = sh('npm', ['run', 'build'], { stdio: 'inherit', encoding: undefined });
// Checked explicitly: a build that failed must never reach the restart below.
if (build.status !== 0) die(`build failed (exit ${build.status})`, 'the service was left untouched and is still serving the previous build.');
console.log('\n  ✓ build ok');

if (buildOnly) {
  console.log('  --build-only: service not restarted.\n');
  process.exit(0);
}

// ---- restart ----------------------------------------------------------------

if (sh('launchctl', ['list', LABEL]).status !== 0) {
  die(`launchd job '${LABEL}' is not loaded`, `the build succeeded. Start the cockpit yourself, or load the job:\n    launchctl bootstrap gui/$(id -u) ${PLIST}`);
}

// `kickstart -k` restarts the job in place. It re-reads nothing from the plist,
// which is exactly right here: this script changes code, never the service
// definition. Edit the plist by hand and bootout/bootstrap it instead.
const kick = sh('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${LABEL}`]);
if (kick.status !== 0) die(`kickstart failed: ${(kick.stderr ?? '').trim()}`, 'the new build is on disk; restart the job manually.');

// ---- verify -----------------------------------------------------------------

// Discovered from the job itself rather than hardcoded, so a cockpit moved to
// another port still gets verified instead of silently reported as down.
const port = (() => {
  try {
    const argv = JSON.parse(out('plutil', ['-extract', 'ProgramArguments', 'json', '-o', '-', PLIST]));
    const i = argv.indexOf('--port');
    return i >= 0 && argv[i + 1] ? argv[i + 1] : '4321';
  } catch {
    return '4321';
  }
})();

process.stdout.write(`  waiting for http://127.0.0.1:${port} `);
for (let i = 0; i < 20; i += 1) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const health = await res.json();
      console.log('\n');
      console.log(`  ✓ cockpit v${health.version} on :${port}`);
      console.log(`    repo   ${health.repoRoot}`);
      console.log(`    branch ${health.repo?.branch}\n`);
      process.exit(0);
    }
  } catch {} // not listening yet
  process.stdout.write('.');
  await new Promise((r) => setTimeout(r, 1000));
}
die(`cockpit did not answer on :${port} within 20s`, `the build succeeded and the job was kicked. Check the log:\n    tail -50 ~/Library/Logs/cezar-cockpit.log`);
