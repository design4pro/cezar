#!/usr/bin/env node
// One tick of the reconciler (ADR 0009): the host-layer loop that repairs failed unattended
// tasks and starts the next task a managed project's backlog asks for. cron runs it every ten
// minutes under `flock`, so ticks never overlap and nothing is held in memory between them.
//
//   node host/reconciler/reconcile.mjs --project <id>=<path> [--project ...] [--dry-run] [--max-launch N]
//
// Env: CEZ_API (default http://127.0.0.1:4321). `gh` and `git` run as the user cron runs as; set
// GH_CONFIG_DIR on the cron line to act as another GitHub login.
//
// It is level-triggered: every tick re-reads the cockpit, the repository and GitHub, decides, and
// forgets. No baseline, receipt or missed event can strand work, because nothing is waiting for
// an event. The one thing it remembers is `~/.cache/cez/reconcile-state.json` (repair attempts,
// escalations, retried receipts, the day of the last digest), and deleting that only means a
// failed task gets its two repairs again.
//
// The judgement is `decide`, a pure function of one snapshot; everything around it is a read of
// the cockpit, git or `gh`, and the writes `decide` asked for. Per project a tick does, in order:
//
//   1 sync    fast-forward the main checkout to origin, re-apply automations if their file changed
//   2 repair  continue (or relaunch) a failed unattended run twice, then hand it to a person
//   3 launch  start what `backlog-status.mjs --plan` asks for, while a slot is free
//   4 digest  once a day, replace the body of the "Pipeline status" issue
//
// The engine is untouched: everything it needs is already an HTTP route (owner decision
// 2026-10-02). Slots are the engine's `maxParallel`, counted the way its `busySlots` counts them.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_API = "http://127.0.0.1:4321";
const STATE_FILE = join(homedir(), ".cache", "cez", "reconcile-state.json");

const HOUR_MS = 3_600_000;
/** A failed run older than this is history, not work: it is neither repaired nor retried. */
const REPAIR_WINDOW_MS = 48 * HOUR_MS;
/** What the digest reports on. */
const REPORT_WINDOW_MS = 24 * HOUR_MS;
const STATE_RETENTION_MS = 14 * 24 * HOUR_MS;
/** A target a run finished in this long ago is not started again by the same workflow. */
const DONE_COOLDOWN_MS = 6 * HOUR_MS;
const MAX_REPAIRS = 2;
const MAX_ACTIVE_PER_PROJECT = 2;
/** Two Claude Code processes starting in the same second race on the OAuth refresh (PR #50). */
const START_STAGGER_MS = 20_000;
/** An automation poll this close, either side, may be mid-read of the working tree. */
const SYNC_MARGIN_MS = 60_000;
const DIGEST_ZONE = "Europe/Warsaw";
const DIGEST_HOUR = 7;
const DIGEST_TITLE = "Pipeline status";

const USAGE = `usage: node host/reconciler/reconcile.mjs --project <id>=<path> [--project ...] [--dry-run] [--max-launch N]
  --project <id>=<path>  a managed project: its cockpit id and its checkout (repeat; order = priority)
  --dry-run              decide and print, change nothing (no merge, no POST, no GitHub write)
  --max-launch N         start at most N runs this tick, repairs included`;

// ---- pure core -----------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set(["done", "failed", "cancelled"]);

/** A run that is neither finished nor abandoned: it owns its work. */
export const isOpen = (run) => !TERMINAL_STATUSES.has(run.status);

/**
 * Runs that hold or wait for one of the workspace's `maxParallel` slots, counted the way the
 * engine's own `busySlots` counts them (packages/cezar/src/workflows/run.ts): a `waiting` run
 * holds none (#347), a run watching its downstream work (`running` with `activity: monitoring`)
 * holds none up to `maxMonitoringSessions`, and a `queued` run is about to take one. A `review`
 * run has closed its session.
 */
export function slotsHeld(runs, maxMonitoring) {
  const running = runs.filter((run) => run.status === "running");
  const monitoring = running.filter((run) => run.activity === "monitoring").length;
  const queued = runs.filter((run) => run.status === "queued").length;
  return queued + (running.length - monitoring) + Math.max(0, monitoring - maxMonitoring);
}

const CLAUDE_LIMIT_RE = /usage limit reached\s*\|\s*(\d{9,16})/i;

/**
 * A run parked on a provider usage limit (spec 2026-08-03-auto-resume-after-usage-limit). The
 * engine keeps it `failed` and books its own resume in `autoResumeAt`, which exists only for that
 * state. A limit it did not book (auto-resume off, cap spent) still names its reset instant in
 * Claude Code's envelope, which is read here only while that instant is ahead.
 */
export function isParkedOnUsageLimit(run, now) {
  if (run.status !== "failed") return false;
  if (run.autoResumeAt) return true;
  const marker = CLAUDE_LIMIT_RE.exec(run.error ?? "");
  if (!marker) return false;
  const raw = Number(marker[1]);
  return (raw >= 1e12 ? raw : raw * 1000) > now;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a task names a plan target: `#N` as a whole number (`#12` is not `#123`), an exact spec
 * path (`x.md` is not `x.md.bak`, but `x.md.` ends a sentence), or an exact stage id (`02-S3` is
 * not `02-S31`).
 */
export function mentionsTarget(task, target) {
  const escaped = escapeRegExp(target);
  const pattern = target.startsWith("#")
    ? `(?<!\\w)${escaped}(?!\\w)`
    : `(?<![\\w./-])${escaped}(?![\\w/-]|\\.\\w)`;
  return new RegExp(pattern).test(task);
}

/**
 * The issue a failed task was about. The task's own `#N` first: a reconciler launch always names
 * its target there, while `issueNumber` is discovered from what the agent read and is documented
 * as display-only.
 */
export function targetIssue(run) {
  const named = /(?<!\w)#(\d+)/.exec(run.task ?? "");
  if (named) return Number(named[1]);
  return run.issueNumber ?? null;
}

const NON_RETRYABLE = [
  [/not found on PATH/i, "the runner CLI is not installed"],
  [/credentials are unavailable|is disabled\. Enable it/i, "the provider has no usable login"],
  [/unknown workflow/i, "the workflow no longer exists"],
];
const LOST_SESSION_RE = /No conversation found with session ID/i;

/** Why repeating a failed run cannot help, or null. Retrying these only fails the same way. */
export function nonRetryableReason(run) {
  const error = `${run.error ?? ""}\n${run.steps?.map((step) => step.error ?? "").join("\n") ?? ""}`;
  for (const [pattern, why] of NON_RETRYABLE) if (pattern.test(error)) return why;
  return null;
}

/**
 * A step with an agent session to reopen. A session the provider no longer has (`No conversation
 * found`, seen on 2026-09-24) is as good as none: Continue would fail the same way twice.
 */
export function hasSession(run) {
  return (
    run.steps?.some((step) => step.sessionId) === true && !LOST_SESSION_RE.test(run.error ?? "")
  );
}

const withoutFinalStop = (text) => text.replace(/[.\s]+$/, "");

export function firstErrorLine(run) {
  const text = run.error ?? run.steps?.find((step) => step.error)?.error ?? "";
  const line = text.split("\n").find((candidate) => candidate.trim());
  return line ? line.trim().slice(0, 300) : "no error recorded";
}

/** The workflow step the failure belongs to; `continue-N` steps are the engine's, not the file's. */
export function resumeStep(run) {
  const steps = (run.steps ?? []).filter((step) => !step.id.startsWith("continue-"));
  return (
    steps.find((step) => step.status === "failed") ??
    steps.find((step) => step.status !== "done" && step.status !== "skipped") ??
    steps.at(-1) ?? { id: "the failed step" }
  );
}

/**
 * The message a Continue carries. Attempt 2 adds a root-cause pass first: the first attempt tried
 * the obvious, so the second asks for the cause before the fix.
 */
export function recoveryText(run, attempt) {
  const step = resumeStep(run);
  return [
    `Step \`${step.id}\` failed: ${withoutFinalStop(firstErrorLine(run))}.`,
    "Resume from this run's handoff journal.",
    attempt >= 2
      ? "First hand the failure to an independent root-cause specialist sub-agent through the Agent tool (read-only, om-root-cause rules: reproduce, name the cause with evidence, propose the smallest fix), apply its fix, then continue."
      : null,
    `Finish step \`${step.id}\` and then every later step of \`.ai/cezar/workflows/${run.workflow}.yml\` yourself, in order, as written there, running each check step's command yourself and fixing what fails. Do not stop at the first problem: diagnose it, fix it, continue. End with your done signal.`,
  ]
    .filter(Boolean)
    .join(" ");
}

export function escalationComment(run) {
  return `🤖 HUMAN-ONLY: the unattended ${run.workflow} task ${run.id.slice(0, 8)} failed again after two automatic repairs: ${withoutFinalStop(firstErrorLine(run))}. Read it in the cockpit, then remove \`blocked\`.`;
}

const finishedMs = (run) => Date.parse(run.finishedAt ?? run.createdAt ?? "");
/** False for a run with no readable time: unknown is old, never recent. */
const finishedWithin = (run, now, windowMs) => now - finishedMs(run) <= windowMs;

/**
 * A failed run the reconciler may repair: unattended, recent, not the engine's own booked resume,
 * and the newest of its kind. A newer run of the same workflow and task has taken the work over,
 * whether the reconciler relaunched it, a schedule fired again or a person started it, so an older
 * failure is history rather than a second job.
 */
export function isRepairCandidate(run, runs, now) {
  if (run.status !== "failed" || run.autonomous !== true || run.archived) return false;
  if (run.autoResumeAt || !finishedWithin(run, now, REPAIR_WINDOW_MS)) return false;
  return !runs.some(
    (other) =>
      other.id !== run.id &&
      other.workflow === run.workflow &&
      other.task === run.task &&
      other.createdAt > run.createdAt,
  );
}

/** Launch-error receipts a person did not already retry and the reconciler has not retried. */
export function retryableReceipts(receipts, now, state) {
  return receipts.filter(
    (receipt) =>
      receipt.status === "launch-error" &&
      !receipt.runId &&
      now - Date.parse(receipt.updatedAt) <= REPAIR_WINDOW_MS &&
      !(receipt.receiptId in state.retriedReceipts),
  );
}

/** The newest line per `receiptKey` of an `automation-receipts.ndjson`: that is a receipt's state. */
export function latestReceipts(ndjson) {
  const latest = new Map();
  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue;
    try {
      const receipt = JSON.parse(line);
      if (receipt.receiptKey) latest.set(receipt.receiptKey, receipt);
    } catch {
      // A torn last line is the writer mid-append, not a reason to read nothing.
    }
  }
  return [...latest.values()];
}

/**
 * The first enabled automation whose next poll is within the margin, either side: ahead it is
 * about to read the working tree, behind it is reading it now. A state for an automation that is
 * not enabled (or not listed) never blocks.
 */
export function imminentPoll(states, enabledIds, now, margin = SYNC_MARGIN_MS) {
  for (const [id, entry] of Object.entries(states ?? {})) {
    if (enabledIds && !enabledIds.has(id)) continue;
    const next = Date.parse(entry?.nextCheckAt ?? "");
    if (Number.isFinite(next) && Math.abs(next - now) <= margin) return id;
  }
  return null;
}

const zoneParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: DIGEST_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

/** The Warsaw calendar date and hour of an instant, whatever zone the host runs in (cron: UTC). */
export function warsawClock(now) {
  const parts = Object.fromEntries(zoneParts.formatToParts(now).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** The first tick at or after 07:00 Warsaw on a day that has not had its digest. */
export function digestDue(now, lastDigestDate) {
  const { date, hour } = warsawClock(now);
  return hour >= DIGEST_HOUR && lastDigestDate !== date;
}

export function emptyState() {
  return { repairs: {}, retriedReceipts: {}, digests: {} };
}

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** Whatever the file held, as a usable state: a corrupt or foreign file is empty, never fatal. */
export function normalizeState(raw) {
  const state = emptyState();
  if (!isRecord(raw)) return state;
  for (const [id, entry] of Object.entries(isRecord(raw.repairs) ? raw.repairs : {})) {
    if (isRecord(entry) && Number.isInteger(entry.attempts) && typeof entry.at === "string") {
      state.repairs[id] = { attempts: entry.attempts, at: entry.at };
      if (entry.escalated === true) state.repairs[id].escalated = true;
    }
  }
  for (const [id, at] of Object.entries(isRecord(raw.retriedReceipts) ? raw.retriedReceipts : {})) {
    if (typeof at === "string") state.retriedReceipts[id] = at;
  }
  for (const [id, date] of Object.entries(isRecord(raw.digests) ? raw.digests : {})) {
    if (typeof date === "string") state.digests[id] = date;
  }
  return state;
}

/** Drop what is too old to matter: a run past the repair window is never looked at again. */
export function pruneState(state, now) {
  const fresh = (at) => now - Date.parse(at) <= STATE_RETENTION_MS;
  return {
    ...state,
    repairs: Object.fromEntries(Object.entries(state.repairs).filter(([, e]) => fresh(e.at))),
    retriedReceipts: Object.fromEntries(Object.entries(state.retriedReceipts).filter(([, at]) => fresh(at))),
  };
}

/**
 * The plan `backlog-status.mjs --plan` printed, as a list of actions. A malformed one is loud
 * (the contract with the app repos drifted), never a partial launch.
 */
export function parsePlan(text) {
  const plan = JSON.parse(text);
  if (!isRecord(plan) || !Array.isArray(plan.actions)) throw new Error("plan has no actions array");
  plan.actions.forEach((action, index) => {
    for (const key of ["kind", "target", "workflow", "task"]) {
      if (typeof action?.[key] !== "string" || !action[key]) {
        throw new Error(`plan action ${index} has no ${key}`);
      }
    }
  });
  return plan.actions;
}

/** `owner/repo` of a GitHub remote URL, ssh or https. */
export function parseGithubRepo(remoteUrl) {
  const match = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  return match ? match[1] : null;
}

/**
 * Everything one tick decides, as an ordered list of actions. The snapshot is
 *
 *   now          epoch ms
 *   maxParallel  the workspace cap; maxMonitoring the monitoring exemption
 *   maxLaunch    runs this tick may start at most (Infinity when unset)
 *   state        the normalized state file
 *   projects[]   every registered project, managed ones first and in priority order:
 *                { id, managed, runs, plan (actions, or null when unavailable), receipts }
 *
 * Capacity is the workspace's, not a project's: the cap protects the host, and one account's
 * limit closes every project at once, so a run parked on a usage limit anywhere pauses every
 * repair and launch. Each run the tick starts (repair, receipt retry, launch) spends one unit of
 * capacity and one of `maxLaunch`.
 */
export function decide(snapshot) {
  const { now, state } = snapshot;
  const actions = [];
  const everyRun = snapshot.projects.flatMap((project) => project.runs);
  const parked = everyRun.find((run) => isParkedOnUsageLimit(run, now));
  if (parked) {
    actions.push({
      type: "pause",
      reason: `run ${parked.id.slice(0, 8)} is parked on a usage limit: nothing starts and nothing is repaired`,
    });
  }
  const free = snapshot.maxParallel - slotsHeld(everyRun, snapshot.maxMonitoring);
  let budget = Math.min(Math.max(0, free), snapshot.maxLaunch);
  const wait = (project, subject) => ({
    type: "skip",
    project,
    subject,
    reason: `no free slot (${snapshot.maxParallel} in all, ${slotsHeld(everyRun, snapshot.maxMonitoring)} held)`,
  });

  for (const project of snapshot.projects.filter((candidate) => candidate.managed)) {
    const failures = project.runs.filter((run) => run.status === "failed" || run.status === "cancelled");
    // The tasks that already own a target: running work, and work that stopped within the repair
    // window. Without the second, a failed run's issue is still `ready` and gets launched again
    // beside its own repair, and a target nobody can fix is relaunched every ten minutes.
    const owned = [
      ...project.runs.filter(isOpen),
      ...failures.filter((run) => finishedWithin(run, now, REPAIR_WINDOW_MS)),
    ].map((run) => run.task);
    // A run that ended `done` while the plan still asks for its target judged the work finished
    // (a triage that left no label, a slice that filed nothing). Starting the same workflow on it
    // every ten minutes would repeat that judgement and spend a run each time.
    const recentlyDone = project.runs.filter(
      (run) => run.status === "done" && finishedWithin(run, now, DONE_COOLDOWN_MS),
    );
    // Only runs that hold a slot: a monitoring PR autopilot or a person's waiting chat must not
    // stop the project's backlog.
    let active = slotsHeld(project.runs, Infinity);

    if (!parked) {
      for (const receipt of retryableReceipts(project.receipts, now, state)) {
        if (budget <= 0) {
          actions.push(wait(project.id, `retry of receipt ${receipt.receiptId.slice(0, 8)}`));
          continue;
        }
        budget -= 1;
        actions.push({ type: "retry-receipt", project: project.id, receipt });
      }

      const candidates = project.runs
        .filter((run) => isRepairCandidate(run, project.runs, now))
        .sort((a, b) => finishedMs(a) - finishedMs(b));
      for (const run of candidates) {
        const subject = `repair of ${run.id.slice(0, 8)} (${run.workflow})`;
        const why = nonRetryableReason(run);
        if (why) {
          actions.push({ type: "skip", project: project.id, subject, reason: `not retryable: ${why}` });
          continue;
        }
        const entry = state.repairs[run.id];
        const attempts = entry?.attempts ?? 0;
        if (attempts >= MAX_REPAIRS) {
          if (!entry?.escalated) {
            actions.push({ type: "escalate", project: project.id, run, issue: targetIssue(run) });
          }
          continue;
        }
        const mode = hasSession(run) ? "continue" : "relaunch";
        if (mode === "relaunch" && run.workflow === "(planned)") {
          actions.push({
            type: "skip",
            project: project.id,
            subject,
            reason: "not retryable: an inline chain has no session and no file to relaunch from",
          });
          continue;
        }
        if (budget <= 0) {
          actions.push(wait(project.id, subject));
          continue;
        }
        budget -= 1;
        active += 1;
        actions.push({ type: "repair", project: project.id, mode, run, attempt: attempts + 1 });
      }

      const seenKinds = new Set();
      for (const planned of project.plan ?? []) {
        const subject = `${planned.kind} ${planned.target}`;
        const skip = (reason) => actions.push({ type: "skip", project: project.id, subject, reason });
        // The plan holds one action per kind; if it ever held two, the first is the one it meant.
        const repeated = seenKinds.has(planned.kind);
        seenKinds.add(planned.kind);
        if (repeated) {
          skip(`a ${planned.kind} action came first`);
        } else if (owned.some((task) => mentionsTarget(task, planned.target))) {
          skip("a run already owns this target");
        } else if (
          recentlyDone.some((run) => run.workflow === planned.workflow && mentionsTarget(run.task, planned.target))
        ) {
          skip(`a ${planned.workflow} run finished on this target within ${DONE_COOLDOWN_MS / HOUR_MS} hours`);
        } else if (active >= MAX_ACTIVE_PER_PROJECT) {
          skip(`the project already has ${active} active runs`);
        } else if (budget <= 0) {
          actions.push(wait(project.id, subject));
          break;
        } else {
          budget -= 1;
          active += 1;
          owned.push(planned.task);
          actions.push({ type: "launch", project: project.id, ...planned });
        }
      }
    }

    if (digestDue(now, state.digests[project.id])) actions.push({ type: "digest", project: project.id });
  }
  return actions;
}

// ---- the digest ----------------------------------------------------------------------------

/** Why an open pull request waits for a person: QA nobody approved, or a risk a skill may not take. */
export function waitingReasons(pr) {
  const labels = new Set((pr.labels ?? []).map((label) => label.name ?? label));
  const reasons = [];
  if (labels.has("needs-qa") && !labels.has("qa-approved")) reasons.push("needs-qa");
  if (labels.has("risk-high")) reasons.push("risk-high");
  if (labels.has("security")) reasons.push("security");
  return reasons;
}

const bullets = (items, render, max = 30) => {
  if (items.length === 0) return "None.";
  const shown = items.slice(0, max).map((item) => `- ${render(item)}`);
  if (items.length > max) shown.push(`- ... and ${items.length - max} more`);
  return shown.join("\n");
};

/**
 * The body of the "Pipeline status" issue: everything that waits for a person, and the pulse of
 * the unattended runs. `issues` is the array `backlog-status.mjs --json` prints (already ordered
 * by state), `prs` the open pull requests, `runs` the project's runs.
 */
export function digestBody({ now, issues, prs, runs, state }) {
  const since = now - REPORT_WINDOW_MS;
  const recent = runs.filter((run) => finishedMs(run) >= since);
  const needAPerson = recent.filter(
    (run) => run.status === "failed" && (state.repairs[run.id]?.escalated || nonRetryableReason(run)),
  );
  const done = recent.filter((run) => run.status === "done");
  const waitingPrs = prs.map((pr) => ({ pr, reasons: waitingReasons(pr) })).filter((x) => x.reasons.length);
  const blocked = issues.filter((issue) => issue.state === "BLOCKED");
  const counts = new Map();
  for (const issue of issues) counts.set(issue.state, (counts.get(issue.state) ?? 0) + 1);
  const runLine = (run) => `\`${run.id.slice(0, 8)}\` ${run.workflow}`;

  return [
    `Updated ${new Date(now).toISOString()} by the host reconciler. One issue, edited in place: do not close it.`,
    "## Backlog",
    counts.size
      ? ["| State | Issues |", "| --- | --- |", ...[...counts].map(([name, n]) => `| ${name} | ${n} |`)].join("\n")
      : "No open issues.",
    "## Waiting for a person",
    `### Blocked issues (${blocked.length})`,
    bullets(blocked, (issue) => `[#${issue.number}](${issue.url}) ${issue.title}`),
    `### Pull requests (${waitingPrs.length})`,
    bullets(waitingPrs, ({ pr, reasons }) => `[#${pr.number}](${pr.url}) ${pr.title}: ${reasons.join(", ")}`),
    "## Unattended runs, last 24 hours",
    `### Escalated or not retryable (${needAPerson.length})`,
    bullets(needAPerson, (run) => `${runLine(run)}: ${firstErrorLine(run)}`),
    `### Done (${done.length})`,
    bullets(done, (run) => `${runLine(run)}: ${run.task.split("\n")[0].slice(0, 100)}`),
  ].join("\n\n");
}

// ---- the decisions, as log lines -----------------------------------------------------------

export function describe(action) {
  switch (action.type) {
    case "pause":
      return `pause: ${action.reason}`;
    case "skip":
      return `skip ${action.subject}: ${action.reason}`;
    case "retry-receipt":
      return `retry receipt ${action.receipt.receiptId.slice(0, 8)}: ${(action.receipt.error ?? "launch error").slice(0, 120)}`;
    case "repair":
      return `${action.mode} ${action.run.id.slice(0, 8)} (${action.run.workflow}) attempt ${action.attempt}: ${firstErrorLine(action.run)}`;
    case "escalate":
      return action.issue === null
        ? `escalate ${action.run.id.slice(0, 8)} (${action.run.workflow}): no target issue, digest only`
        : `escalate ${action.run.id.slice(0, 8)} (${action.run.workflow}): blocked + HUMAN-ONLY on #${action.issue}`;
    case "launch":
      return `launch ${action.kind} ${action.target} -> ${action.workflow}`;
    case "digest":
      return `digest: due (after ${String(DIGEST_HOUR).padStart(2, "0")}:00 ${DIGEST_ZONE})`;
    default:
      return `unknown action ${action.type}`;
  }
}

// ---- argv ----------------------------------------------------------------------------------

/** Throws on anything it does not know: a typo on a cron line must be as red as a real failure. */
export function parseArgs(argv) {
  const options = { projects: [], dryRun: false, maxLaunch: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--project") {
      const value = argv[++i] ?? "";
      const split = value.indexOf("=");
      if (split < 1 || split === value.length - 1) {
        throw new Error(`--project needs <id>=<path>, got ${value || "nothing"}`);
      }
      const id = value.slice(0, split);
      if (options.projects.some((project) => project.id === id)) throw new Error(`--project ${id} given twice`);
      options.projects.push({ id, root: resolve(value.slice(split + 1)) });
    } else if (arg === "--max-launch") {
      const value = argv[++i];
      if (!/^\d+$/.test(value ?? "") || Number(value) === 0) {
        throw new Error(`--max-launch needs a positive whole number, got ${value ?? "nothing"}`);
      }
      options.maxLaunch = Number(value);
    } else throw new Error(`unknown argument ${arg}`);
  }
  if (options.projects.length === 0) throw new Error("at least one --project is required");
  return options;
}

// ---- IO shell ------------------------------------------------------------------------------

const log = (project, message) => console.log(`${new Date().toISOString()} ${project} ${message}`);
const firstLine = (text) => String(text ?? "").split("\n").find((line) => line.trim())?.trim() ?? "";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function run(command, args, { cwd, input, env } = {}) {
  return execFileSync(command, args, {
    cwd,
    input,
    env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/** What a failed child process said, on one line. */
const failure = (error) => firstLine(error.stderr) || firstLine(error.message);
const lastLine = (text) => String(text ?? "").trim().split("\n").at(-1);

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

function loadState() {
  return normalizeState(readJson(STATE_FILE));
}

/** tmp + rename, so a crash mid-write leaves the old file whole. */
function saveState(state, now) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(pruneState(state, now), null, 2)}\n`);
  renameSync(tmp, STATE_FILE);
}

function createApi(base) {
  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // A non-JSON body is reported through `text`.
    }
    return { ok: response.ok, status: response.status, json, text };
  };
  return {
    get: (path) => call("GET", path),
    post: (path, body = {}) => call("POST", path, body),
  };
}

/** The error a route answered with, on one line. */
const answered = (response) => `${response.status} ${response.json?.error ?? firstLine(response.text)}`;

const ghApi = (root, args, payload) =>
  run("gh", ["api", ...args, ...(payload ? ["--input", "-"] : [])], {
    cwd: root,
    input: payload ? JSON.stringify(payload) : undefined,
  });

function repoOf(root) {
  const repo = parseGithubRepo(run("git", ["remote", "get-url", "origin"], { cwd: root }));
  if (!repo) throw new Error("origin is not a GitHub remote");
  return repo;
}

/**
 * Fast-forward the main checkout to its base branch and re-apply the automation definitions when
 * their file moved. Each refusal is a state to wait out, not a failure: a checkout on another
 * branch, a dirty tree, an automation about to poll (it reads workflows from this working tree,
 * SDLC.md § Repo automations). In a dry run it only reads, and says what it would do.
 */
function syncProject({ id, root }, dryRun) {
  const say = (message) => log(id, `${dryRun ? "would " : ""}sync: ${message}`);
  const git = (...args) => run("git", args, { cwd: root });
  const base = readJson(join(root, ".ai/agentic.config.json"))?.baseBranch;
  if (!base) return say("skipped, no baseBranch in .ai/agentic.config.json");
  try {
    const branch = git("rev-parse", "--abbrev-ref", "HEAD");
    if (branch !== base) return say(`skipped, checkout is on ${branch}, not ${base}`);
    if (git("status", "--porcelain", "--untracked-files=no")) return say("skipped, the working tree is dirty");

    const head = git("rev-parse", "HEAD");
    const enabled = new Set(
      (readJson(join(root, ".ai/cezar/automations.json"))?.automations ?? [])
        .filter((automation) => automation.enabled)
        .map((automation) => automation.id),
    );
    const poll = imminentPoll(readJson(join(root, ".ai/cezar/automation-state.json"))?.states, enabled, Date.now());
    if (dryRun) {
      const remote = git("ls-remote", "origin", `refs/heads/${base}`).split(/\s+/)[0];
      if (!remote) return say(`origin has no ${base}`);
      if (remote === head) return say("up to date");
      return say(
        poll
          ? `blocked, automation ${poll.slice(0, 8)} polls within ${SYNC_MARGIN_MS / 1000} s`
          : `fetch and fast-forward ${head.slice(0, 7)} -> ${remote.slice(0, 7)}`,
      );
    }
    git("fetch", "origin", base);
    if (git("rev-list", "--count", `HEAD..origin/${base}`) === "0") return say("up to date");
    if (poll) return say(`skipped, automation ${poll.slice(0, 8)} polls within ${SYNC_MARGIN_MS / 1000} s`);

    git("merge", "--ff-only", `origin/${base}`);
    say(`fast-forwarded ${head.slice(0, 7)} -> ${git("rev-parse", "--short=7", "HEAD")}`);
    const changed = git("diff", "--name-only", `${head}..HEAD`, "--", "docs/agents/cezar-automations.json");
    if (changed && existsSync(join(root, ".ai/scripts/cez-automations.sh"))) reapplyAutomations({ id, root });
  } catch (error) {
    say(`failed, ${failure(error)}`);
  }
}

/** The script reports on stderr and ends on its error, so merge the two and read the whole. A failed
 *  re-apply is logged and not retried: the merge already moved HEAD past the change that asked. */
function reapplyAutomations({ id, root }) {
  try {
    const output = run("bash", ["-c", ".ai/scripts/cez-automations.sh 2>&1"], {
      cwd: root,
      env: { ...process.env, CEZ_PROJECT: id },
    });
    log(id, `sync: re-applied automations: ${output.replace(/\s*\n\s*/g, "; ")}`);
  } catch (error) {
    log(id, `sync: re-applying automations failed, run .ai/scripts/cez-automations.sh by hand (${lastLine(error.stdout) || failure(error)})`);
  }
}

/** The plan, or null with the reason logged: a project without `--plan` launches nothing. */
function readPlan({ id, root }) {
  const script = join(root, ".ai/scripts/backlog-status.mjs");
  try {
    if (!existsSync(script)) throw new Error("no .ai/scripts/backlog-status.mjs");
    return parsePlan(run("node", [script, "--plan"], { cwd: root }));
  } catch (error) {
    log(id, `plan: unavailable, nothing launches (${failure(error)})`);
    return null;
  }
}

function readReceipts(root) {
  try {
    return latestReceipts(readFileSync(join(root, ".ai/cezar/automation-receipts.ndjson"), "utf8"));
  } catch {
    return [];
  }
}

async function fetchRuns(api, id) {
  const response = await api.get(`/api/v1/p/${id}/runs`);
  if (response.ok && Array.isArray(response.json)) return response.json;
  log(id, `runs: unreadable (${answered(response)}), counted as none`);
  return [];
}

/** Print the digest in a dry run; otherwise create or replace the "Pipeline status" issue. */
async function publishDigest(project, { now, state, dryRun }) {
  const { id, root } = project;
  const issues = JSON.parse(run("node", [".ai/scripts/backlog-status.mjs", "--json"], { cwd: root }));
  const prs = JSON.parse(
    run("gh", ["pr", "list", "--state", "open", "--limit", "100", "--json", "number,title,url,labels"], { cwd: root }),
  );
  const body = digestBody({ now, issues, prs, runs: project.runs, state });
  if (dryRun) return console.log(`--- ${id}: "${DIGEST_TITLE}" body ---\n${body}\n---`);

  const repo = repoOf(root);
  // Search rather than list: the page is edited daily, but a busy repository can push it off a
  // first page of recently updated issues. Exact title only, the search is a substring match.
  const found = JSON.parse(
    ghApi(root, ["-X", "GET", "search/issues", "-f", `q=repo:${repo} is:issue is:open in:title "${DIGEST_TITLE}"`]),
  ).items.find((item) => item.title === DIGEST_TITLE);
  if (found) ghApi(root, ["-X", "PATCH", `repos/${repo}/issues/${found.number}`], { body });
  else ghApi(root, ["-X", "POST", `repos/${repo}/issues`], { title: DIGEST_TITLE, body, labels: ["do-not-close"] });
  state.digests[id] = warsawClock(now).date;
  log(id, `digest: ${found ? `replaced the body of #${found.number}` : "created the issue"}`);
}

async function escalate(action, { root }, { state, now }) {
  const previous = state.repairs[action.run.id] ?? { attempts: MAX_REPAIRS, at: new Date(now).toISOString() };
  if (action.issue !== null) {
    const repo = repoOf(root);
    // The label first: it is idempotent, so a retry after a failed comment repeats nothing visible.
    ghApi(root, ["-X", "POST", `repos/${repo}/issues/${action.issue}/labels`], { labels: ["blocked"] });
    ghApi(root, ["-X", "POST", `repos/${repo}/issues/${action.issue}/comments`], {
      body: escalationComment(action.run),
    });
  }
  state.repairs[action.run.id] = { ...previous, escalated: true };
}

/** Start one run, or reopen one, and return its id; null when the cockpit refused. */
async function start(action, { api, state, now }) {
  const at = new Date(now).toISOString();
  const refused = (response, what) => {
    log(action.project, `${what} refused: ${answered(response)}`);
    return null;
  };
  if (action.type === "retry-receipt") {
    const { receiptId } = action.receipt;
    const response = await api.post(`/api/v1/p/${action.project}/automation-log/${receiptId}/retry`);
    // Once each, whatever the answer: a retry the cockpit refuses will be refused again.
    state.retriedReceipts[receiptId] = at;
    return response.ok ? (response.json?.runId ?? receiptId) : refused(response, "retry");
  }
  if (action.type === "repair" && action.mode === "continue") {
    const response = await api.post(`/api/v1/p/${action.project}/runs/${action.run.id}/continue`, {
      text: recoveryText(action.run, action.attempt),
    });
    if (!response.ok) return refused(response, "continue");
    state.repairs[action.run.id] = { attempts: action.attempt, at };
    return action.run.id;
  }
  // A launch, or the relaunch of a run that never had a session: one body, the one
  // housekeeping.sh starts a run with.
  const repair = action.type === "repair";
  const source = repair ? action.run : action;
  const response = await api.post(`/api/v1/p/${action.project}/runs`, {
    workflow: source.workflow,
    task: source.task,
    worktree: source.worktree !== false,
    autonomous: true,
    variants: 1,
    generateFollowups: false,
    ...(repair && source.runner ? { runner: source.runner } : {}),
    ...(repair && source.model ? { model: source.model } : {}),
  });
  if (!response.ok) return refused(response, repair ? "relaunch" : "launch");
  // The new run inherits the ladder: without it every relaunch would restart at attempt 1.
  if (repair) state.repairs[response.json.id] = { attempts: action.attempt, at };
  return response.json.id;
}

export async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`reconcile: ${error.message}\n${USAGE}`);
    return 2;
  }
  const { dryRun } = options;
  const base = process.env.CEZ_API ?? DEFAULT_API;
  const api = createApi(base);
  const now = Date.now();

  try {
    const health = await api.get("/api/v1/health");
    if (!health.ok) throw new Error(`health answered ${health.status}`);
  } catch (error) {
    log("-", `cockpit unreachable at ${base} (${error.cause?.code ?? error.message}), nothing to do`);
    return 0;
  }
  const [config, registry] = await Promise.all([
    api.get("/api/v1/workspace/config"),
    api.get("/api/v1/projects"),
  ]);
  if (!config.ok || !registry.ok) {
    log("-", `cockpit did not answer config and projects (${answered(config.ok ? registry : config)}), nothing to do`);
    return 0;
  }

  const state = loadState();
  const reachable = new Set(registry.json.projects.filter((row) => row.status === "ok").map((row) => row.id));
  const managed = options.projects.filter((project) => {
    if (!reachable.has(project.id)) log(project.id, "not a registered, reachable project of this cockpit, skipped");
    return reachable.has(project.id);
  });
  const projects = [];
  for (const { id, root } of managed) {
    syncProject({ id, root }, dryRun);
    projects.push({
      id,
      root,
      managed: true,
      runs: await fetchRuns(api, id),
      plan: readPlan({ id, root }),
      receipts: readReceipts(root),
    });
  }
  for (const id of reachable) {
    if (!managed.some((project) => project.id === id)) {
      projects.push({ id, managed: false, runs: await fetchRuns(api, id), plan: null, receipts: [] });
    }
  }

  const resources = config.json.resources ?? {};
  const actions = decide({
    now,
    maxParallel: resources.maxParallel ?? 2,
    maxMonitoring: resources.maxMonitoringSessions ?? 2,
    maxLaunch: options.maxLaunch,
    state,
    projects,
  });
  if (actions.length === 0) log("-", "nothing to do");

  const context = { api, now, state, dryRun };
  const byId = new Map(projects.map((project) => [project.id, project]));
  let lastStart = 0;
  for (const action of actions) {
    log(action.project ?? "-", `${dryRun ? "would " : ""}${describe(action)}`);
    // The one thing a dry run does beyond reading: print the digest it would publish.
    if (action.type === "pause" || action.type === "skip" || (dryRun && action.type !== "digest")) continue;
    try {
      if (action.type === "digest") await publishDigest(byId.get(action.project), context);
      else if (action.type === "escalate") await escalate(action, byId.get(action.project), context);
      else {
        const pause = START_STAGGER_MS - (Date.now() - lastStart);
        if (lastStart && pause > 0) await sleep(pause);
        const runId = await start(action, context);
        if (runId) {
          lastStart = Date.now();
          log(action.project, `started run ${String(runId).slice(0, 8)}`);
        }
      }
    } catch (error) {
      log(action.project, `${action.type} failed: ${failure(error)}`);
    }
  }
  if (!dryRun) saveState(state, now);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`reconcile: ${error.stack ?? error}`);
      process.exit(1);
    },
  );
}
