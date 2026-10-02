#!/usr/bin/env node
// Reports where every open issue sits in the SDLC flow and the single next step that moves it,
// and - with `--next` - names the one issue the scheduled implement-ticket run takes next.
// Read-only: it never applies a label. No label marks an issue ready (ADR 0008); readiness is the
// rule in `classify`, so the report a person reads and the pick a run makes cannot disagree.
// Ported from planned.travel, which runs the same rule.
//
// It keeps no knowledge of its own that another file already holds:
//   - the category, priority and risk labels come from .ai/agentic.config.json;
//   - the trusted authors are the `authors` gates of the issue automations in
//     .ai/automations/*.json: an issue anyone else opened is never auto-implemented, and neither
//     is one filed from production error data (a `sentry-issue` marker), whoever filed it;
//   - "not ready" is read through the 🤖 comment marker every skill writes
//     (.ai/trackers/github.md) - a not-ready comment, or the `STOP:` comment implement-ticket
//     leaves on an issue it would not take - so a human comment newer than it is the answer, and the
//     schedule never picks the same refused issue every tick;
//   - the run queue comes from .ai/cezar/runs.json when the working directory has one.
//
// Why it parses pull-request linkage itself rather than asking the tracker: GitHub populates
// `closingIssuesReferences` / `closedByPullRequestsReferences` only for a pull request into the
// repository's default branch. Measured on money-tracker.online, whose pull requests target
// another branch: 15 of 15 recently merged pull requests carrying an explicit closing keyword
// report an empty list. Parsing keeps the rule the one `om-close-fixed-issues` applies, whichever
// branch a pull request targets.
//
// Usage: node .ai/scripts/backlog-status.mjs [--json | --next] [--stale-hours N]

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const AUTOMATIONS_DIR = ".ai/automations";
const CONFIG = ".ai/agentic.config.json";
const RUNS = ".ai/cezar/runs.json";
// A cockpit run that still holds the issue: `waiting` is a run parked for a message, `review` one
// whose diff waits behind the review gate.
const ACTIVE_RUN_STATES = new Set(["queued", "running", "waiting", "review"]);

/** Open agent PRs at which `--next` stops handing out work, so the queue never outruns review. */
export const WIP_LIMIT = 3;
const HOLD_LABELS = ["blocked", "do-not-merge", "do-not-close"];

export const PRIORITY_ORDER = [
  "priority-extreme",
  "priority-high",
  "priority-medium",
  "priority-low",
];

export const STATE_ORDER = [
  "BLOCKED",
  "RUNNING",
  "QUEUED",
  "STUCK",
  "IN_REVIEW",
  "TRACKING",
  "WAITING",
  "NOT_READY",
  "EXTERNAL",
  "NEEDS_TRIAGE",
  "READY",
];

/**
 * Text with fenced blocks and inline backtick spans removed.
 *
 * A closing keyword inside a code sample is a quotation, not a link - `om-close-fixed-issues`
 * rejects those matches and so does this.
 */
export const stripCode = (text) =>
  String(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ");

/**
 * The issue numbers a text closes, by the rule in `om-close-fixed-issues`: one of the English
 * keywords, preceded by start-of-text or a character that is neither a letter, a digit nor `_`,
 * followed by whitespace and `#{digits}`.
 *
 * Deliberately not wrapped in `\b`: that boundary is ASCII-only and fails silently on a keyword
 * whose first or last character is not ASCII. A bare `#N` mention is never a link.
 */
export function closeKeywordTargets(text) {
  const pattern =
    /(^|[^A-Za-z0-9_])(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s+#(\d+)/gi;
  const found = new Set();
  for (const match of stripCode(text).matchAll(pattern))
    found.add(Number(match[2]));
  return [...found];
}

/**
 * The issue a branch name claims, by the `<type>/issue-<n>-<slug>` convention.
 *
 * The type segment is deliberately open rather than a list: both repositories have cut branches
 * under more prefixes than their own documentation names, and a closed list would quietly stop
 * matching the next one somebody invents.
 */
export function branchIssue(headRefName) {
  const match = /^[^/]+\/issue-(\d+)(?:-|$)/.exec(String(headRefName ?? ""));
  return match ? Number(match[1]) : null;
}

/**
 * The issues listed under a `## Blocked by` heading (the afk-to-tickets ticket shape), read up to
 * the next heading. "None - can start immediately" lists nothing.
 */
export function blockedBy(body) {
  const section = /^#{2,3}\s*Blocked by[ \t]*$([\s\S]*?)(?=^#{1,3}\s|(?![\s\S]))/im.exec(
    stripCode(body),
  );
  return section ? [...section[1].matchAll(/#(\d+)/g)].map((match) => Number(match[1])) : [];
}

/**
 * Open pull requests keyed by the issue each one addresses.
 *
 * Two signals, and which one matched is kept rather than collapsed: a keyword is the author saying
 * the pull request closes the issue, while a branch name says only that the work belongs to it.
 * `#268` on money-tracker.online is the case that fixes the distinction in place - a deliberate
 * partial fix whose branch names issue 189 and whose body says, in its first paragraph, that it
 * does not close it. So a branch-only link raises a question for a human and never a suggested
 * edit; treating it as a missing keyword would have closed an open defect.
 */
export function linkOpenPrs(prs) {
  const byIssue = new Map();
  const add = (issue, pr, viaKeyword) => {
    const links = byIssue.get(issue) ?? [];
    const existing = links.find((l) => l.number === pr.number);
    if (existing) existing.viaKeyword ||= viaKeyword;
    else links.push({ number: pr.number, title: pr.title, viaKeyword });
    byIssue.set(issue, links);
  };

  for (const pr of prs) {
    const keyworded = new Set([
      ...closeKeywordTargets(pr.body),
      ...closeKeywordTargets(pr.title),
    ]);
    for (const issue of keyworded) add(issue, pr, true);
    const claimed = branchIssue(pr.headRefName);
    if (claimed !== null) add(claimed, pr, keyworded.has(claimed));
  }
  return byIssue;
}

/** The committed automation definitions: one JSON object per file under `.ai/automations/`. */
export const readAutomations = (dir = AUTOMATIONS_DIR) =>
  readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));

/**
 * The logins the issue automations trust: the union of their `authors` gates. An automation with
 * no gate adds nobody, so a missing gate makes nothing ready rather than everything.
 */
export function readTrusted(automations) {
  const trusted = new Set();
  for (const automation of automations) {
    if (!(automation.events ?? []).some((event) => event.startsWith("issue."))) continue;
    for (const login of automation.filters?.authors ?? []) trusted.add(login);
  }
  return trusted;
}

/**
 * Every open PR by a trusted author - draft, unlabelled or blocked alike - is WIP `--next` counts;
 * counting only the ones in `review` would let a stalled draft escape the cap. A PR a person holds
 * with `do-not-merge` (a release promotion into `main`, say) is not work in flight, and dependabot
 * is not a trusted author.
 */
export const countWip = (prs, trusted) =>
  prs.filter(
    (pr) =>
      trusted.has(pr.author?.login) &&
      !pr.labels.some((label) => label.name === "do-not-merge"),
  ).length;

// A 🤖-prefixed comment is a skill's; anything else is a human's (.ai/trackers/github.md).
const isAgentComment = (comment) => String(comment.body).trimStart().startsWith("🤖");
const hasBrief = (text) => /^#{2,3}\s*Agent Brief\b/m.test(stripCode(text));

/** One issue's state and the single next step that moves it. Pure: every input is passed in. */
export function classify(
  issue,
  { trusted, sdlcLabels, openIssues, runs, prLinks, staleHours, now },
) {
  const labels = issue.labels.map((label) => label.name);
  const has = (label) => labels.includes(label);
  const comments = issue.comments ?? [];
  const run = runs.get(issue.number);
  const prs = prLinks.get(issue.number) ?? [];

  const notReady = comments
    .filter((c) => isAgentComment(c) && (c.body.includes("not ready") || /\bSTOP:/.test(c.body)))
    .at(-1);
  const answered =
    notReady &&
    comments.some(
      (c) =>
        c.createdAt > notReady.createdAt &&
        // A human's reply, the readiness verifier resolving the gap in the human's place
        // (SDLC.md § Definition of Ready), or afk-triage settling it into an Agent Brief.
        (!isAgentComment(c) ||
          c.body.includes("readiness verified") ||
          (trusted.has(c.author?.login) && hasBrief(c.body))),
    );
  // Only a trusted author's brief counts: the body is the reporter's, so for an issue someone
  // else opened, a brief they wrote into it would be a self-approval.
  const briefed =
    hasBrief(issue.body) ||
    comments.some((c) => trusted.has(c.author?.login) && hasBrief(c.body));
  const missingLabels = Object.entries(sdlcLabels)
    .filter(([, names]) => !names.some(has))
    .map(([group]) => group);
  const waitingOn = blockedBy(issue.body).filter((number) => openIssues.has(number));
  const hoursIdle = (now - Date.parse(issue.updatedAt)) / 36e5;

  const state = (name, next, warning) => ({
    ...issue,
    labels,
    state: name,
    next,
    warning: warning ?? null,
    prs,
  });

  const hold = HOLD_LABELS.filter(has);
  if (hold.length)
    return state(
      "BLOCKED",
      `A person clears \`${hold.join("`, `")}\`: the 🤖 comment names what they must do first.`,
    );

  if (has("in-progress"))
    return hoursIdle > staleHours
      ? state(
          "STUCK",
          `Claimed but idle for ${Math.round(hoursIdle)}h - check the run, then \`gh issue edit ${issue.number} --remove-label in-progress\`.`,
        )
      : state("RUNNING", `A run holds the claim (${run?.workflow ?? "cockpit"}). Wait.`);

  if (run)
    return state("QUEUED", `Cezar has a ${run.status} \`${run.workflow}\` run for it. Wait.`);

  if (prs.length) {
    const numbers = prs.map((pr) => `#${pr.number}`).join(", ");
    const branchOnly = prs.filter((pr) => !pr.viaKeyword);
    const warning = branchOnly.length
      ? `${branchOnly.map((pr) => `#${pr.number}`).join(", ")} names this issue in its branch but no closing keyword links it. Does it close the issue? If it does, the body needs \`Closes #${issue.number}\` or housekeeping will leave this open; if it is a partial fix, nothing to change.`
      : null;
    return state(
      "IN_REVIEW",
      `${numbers} open - drive it with \`/om-pr-autopilot ${prs[0].number}\`.`,
      warning,
    );
  }

  // The parent afk-to-tickets files for a spec: its tickets carry the work, it carries none.
  if (/^Spec: \.ai\/specs\//.test(issue.body ?? ""))
    return state("TRACKING", "A spec parent: its tickets carry the work. Nothing to do.");

  if (waitingOn.length)
    return state(
      "WAITING",
      `Blocked by open ${waitingOn.map((n) => `#${n}`).join(", ")} - the schedule takes it once they close.`,
    );

  if (notReady && !answered)
    return state(
      "NOT_READY",
      "Answer the not-ready or `STOP:` comment, then start `triage` on it from the cockpit.",
    );

  // The body quotes production error data, which anyone who can make the app fail can write, and a
  // sweep that files it runs as the maintainer. Cezar files none today; the rule stays the one
  // planned.travel applies, so an issue moved between the two is judged the same way.
  if (/<!--\s*sentry-issue:/.test(issue.body ?? ""))
    return state(
      "EXTERNAL",
      "Filed from production error data (a `sentry-issue` marker): read it, then start `triage` or `implement-ticket` on it from the cockpit.",
    );

  if (!trusted.has(issue.author?.login))
    return state(
      "EXTERNAL",
      `Opened by ${issue.author?.login ?? "an unknown author"}, whom no automation trusts: read it, then start \`triage\` or \`implement-ticket\` on it from the cockpit, or open it again yourself.`,
    );

  const missing = [
    ...(briefed ? [] : ["Agent Brief"]),
    ...missingLabels.map((group) => `${group} label`),
  ];
  if (missing.length)
    return state(
      "NEEDS_TRIAGE",
      `No ${missing.join(", ")} yet: start \`triage\` on it from the cockpit.`,
    );

  return state(
    "READY",
    "Ready: the scheduled `implement-ticket` run takes it, or start one on it from the cockpit.",
  );
}

const priorityRank = (labels) => {
  const index = PRIORITY_ORDER.findIndex((label) => labels.includes(label));
  return index === -1 ? PRIORITY_ORDER.indexOf("priority-medium") : index;
};

export const sortIssues = (issues) =>
  [...issues].sort(
    (a, b) =>
      STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) ||
      priorityRank(a.labels) - priorityRank(b.labels) ||
      a.number - b.number,
  );

/**
 * The issue the scheduled run takes: the first READY one in report order (highest priority, then
 * oldest), or null while `WIP_LIMIT` agent PRs are open or nothing is ready.
 */
export function pickNext(sortedIssues, wip) {
  if (wip >= WIP_LIMIT) return null;
  return sortedIssues.find((issue) => issue.state === "READY")?.number ?? null;
}

const gh = (args) =>
  JSON.parse(
    execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }),
  );

/** Locally queued or running cockpit runs, keyed by issue number. Absent on a non-cockpit host. */
function readRuns() {
  if (!existsSync(RUNS)) return new Map();
  const byIssue = new Map();
  for (const run of JSON.parse(readFileSync(RUNS, "utf8"))) {
    if (!run.issueNumber || !ACTIVE_RUN_STATES.has(run.status)) continue;
    byIssue.set(Number(run.issueNumber), { status: run.status, workflow: run.workflow });
  }
  return byIssue;
}

/**
 * Reads `--stale-hours` only when the flag is present, and throws on a malformed value or an
 * argument it does not know: a typo must be as red as a real failure, never a silent default.
 */
export function parseArgs(argv) {
  const options = { asJson: false, next: false, staleHours: 24 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") options.asJson = true;
    else if (argv[i] === "--next") options.next = true;
    else if (argv[i] === "--stale-hours") {
      const value = argv[++i];
      if (!/^\d+$/.test(value ?? "") || Number(value) === 0)
        throw new Error(`--stale-hours needs a positive whole number of hours, got ${value ?? "nothing"}`);
      options.staleHours = Number(value);
    } else throw new Error(`unknown argument ${argv[i]} - usage: [--json | --next] [--stale-hours N]`);
  }
  if (options.asJson && options.next) throw new Error("--json and --next are separate outputs - pick one");
  return options;
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`backlog-status: ${error.message}`);
    process.exit(2);
  }
  const { asJson, next, staleHours } = options;

  const { labels } = JSON.parse(readFileSync(CONFIG, "utf8"));
  const trusted = readTrusted(readAutomations());
  const prs = gh([
    "pr", "list", "--state", "open", "--limit", "200",
    "--json", "number,title,body,headRefName,author,labels",
  ]);
  const openIssues = gh([
    "issue", "list", "--state", "open", "--limit", "200",
    "--json", "number,title,url,labels,updatedAt,body,comments,author",
  ]);

  const context = {
    trusted,
    sdlcLabels: { category: labels.category, priority: labels.priority, risk: labels.risk },
    openIssues: new Set(openIssues.map((issue) => issue.number)),
    runs: readRuns(),
    prLinks: linkOpenPrs(prs),
    staleHours,
    now: Date.now(),
  };
  const issues = sortIssues(openIssues.map((issue) => classify(issue, context)));

  if (next) {
    const picked = pickNext(issues, countWip(prs, trusted));
    if (picked !== null) console.log(picked);
    return;
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        issues.map(({ number, title, url, labels, state, next, warning, prs }) => ({
          number, title, url, labels, state, next, warning, prs,
        })),
        null,
        2,
      ),
    );
    return;
  }

  let current = null;
  for (const issue of issues) {
    if (issue.state !== current) console.log(`\n## ${(current = issue.state)}`);
    const priority = PRIORITY_ORDER.find((label) => issue.labels.includes(label)) ?? "priority-medium";
    console.log(`#${issue.number} [${priority.replace("priority-", "")}] ${issue.title}`);
    console.log(`    labels: ${issue.labels.join(", ") || "(none)"}`);
    console.log(`    next:   ${issue.next}`);
    if (issue.warning) console.log(`    ⚠️      ${issue.warning}`);
  }

  const counts = issues.reduce(
    (acc, issue) => ({ ...acc, [issue.state]: (acc[issue.state] ?? 0) + 1 }),
    {},
  );
  console.log(
    `\n${issues.length} open issues - ${Object.entries(counts)
      .map(([state, count]) => `${state} ${count}`)
      .join(", ")}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2));
