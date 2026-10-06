/**
 * The pure half of `reconcile.mjs` is the whole judgement: everything around it is a read of the
 * cockpit, git or `gh`, and the writes `decide` asked for. What can go wrong here is never a crash,
 * it is spend: a task launched twice beside its own repair, a relaunch loop on a target nobody can
 * fix, a launch into an account whose window is shut, or a digest that never comes (or comes at
 * 06:00). Each case below pins one of those, with fixtures built from the shapes the cockpit
 * answers (`GET /runs`) and the app repos print (`backlog-status.mjs --plan`).
 *
 * Nothing here touches the network, `gh`, git or `~/.cezar`.
 */

import { describe, expect, it } from "vitest";

import {
  checksState,
  createApi,
  decide,
  describe as describeAction,
  digestBody,
  digestDue,
  emptyState,
  escalationComment,
  hasSession,
  imminentPoll,
  isParkedOnUsageLimit,
  isRepairCandidate,
  latestReceipts,
  mentionsTarget,
  nonRetryableReason,
  normalizeState,
  parseArgs,
  parseGithubRepo,
  parsePlan,
  pruneState,
  recoveryText,
  retryableReceipts,
  slotsHeld,
  targetIssue,
  waitForQuietPoll,
  warsawClock,
} from "../reconcile.mjs";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const HOUR = 3_600_000;
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

let sequence = 0;
const run = (over = {}) => ({
  id: `r${String(++sequence).padStart(7, "0")}-aaaa-bbbb`,
  workflow: "implement-ticket",
  task: "Work through the task.",
  status: "done",
  autonomous: true,
  createdAt: iso(-3 * HOUR),
  finishedAt: iso(-2 * HOUR),
  steps: [],
  ...over,
});
const failedRun = (over = {}) =>
  run({
    status: "failed",
    error: 'step "implement" failed: the agent exploded',
    steps: [
      { id: "bootstrap", status: "done" },
      { id: "implement", status: "failed", sessionId: "session-1" },
      { id: "gate", status: "pending" },
    ],
    ...over,
  });
const failedWithoutSession = (over = {}) =>
  failedRun({
    error: 'check "bootstrap" failed',
    steps: [{ id: "bootstrap", status: "failed" }, { id: "implement", status: "pending" }],
    ...over,
  });

const act = (kind, target) => ({ kind, target, workflow: `wf-${kind}`, task: `Do ${kind} on ${target}.` });
const receipt = (over = {}) => ({
  receiptId: "3f098880-039c-4e35-97a2-4197137bba64",
  receiptKey: "automation:event",
  status: "launch-error",
  updatedAt: iso(-HOUR),
  error: "write target owned by another run",
  ...over,
});

const project = (id, over = {}) => ({ id, managed: true, runs: [], plan: [], receipts: [], ...over });

/** A snapshot with every digest already published today, so a case is not about the digest. */
function snapshot(projects, over = {}) {
  const state = { ...emptyState(), ...over.state };
  state.digests = { ...Object.fromEntries(projects.map((p) => [p.id, "2026-10-02"])), ...over.state?.digests };
  return { now: NOW, maxParallel: 4, maxMonitoring: 2, maxLaunch: Infinity, projects, ...over, state };
}

const ofType = (actions, type) => actions.filter((action) => action.type === type);
const launches = (actions) => ofType(actions, "launch").map((action) => `${action.project}:${action.target}`);

describe("slotsHeld", () => {
  it("counts running and queued runs, and not waiting, review or finished ones", () => {
    const runs = ["running", "running", "queued", "waiting", "review", "done", "failed", "cancelled"].map((status) =>
      run({ status }),
    );
    expect(slotsHeld(runs, 2)).toBe(3);
  });

  it("exempts monitoring runs up to maxMonitoringSessions, as the engine does", () => {
    const runs = Array.from({ length: 3 }, () => run({ status: "running", activity: "monitoring" }));
    expect(slotsHeld(runs, 2)).toBe(1);
    expect(slotsHeld(runs, 5)).toBe(0);
  });
});

describe("mentionsTarget", () => {
  it("matches an issue number as a whole number: #12 is not #123", () => {
    expect(mentionsTarget("Implement issue #12.", "#12")).toBe(true);
    expect(mentionsTarget("Implement issue #123.", "#12")).toBe(false);
    expect(mentionsTarget("Implement issue #12", "#12")).toBe(true);
    expect(mentionsTarget("see #1, #12 and #120", "#12")).toBe(true);
    expect(mentionsTarget("Implement issue #12 (https://github.com/o/r/issues/12)", "#12")).toBe(true);
  });

  it("matches a spec path and a stage id exactly", () => {
    const path = ".ai/specs/2026-09-30-x.md";
    expect(mentionsTarget(`Slice the spec ${path} into tickets.`, path)).toBe(true);
    expect(mentionsTarget("Slice the spec .ai/specs/2026-09-30-x.md.bak into tickets.", path)).toBe(false);
    expect(mentionsTarget("Write the spec for plan stage 02-S3 (docs/plans/02.md).", "02-S3")).toBe(true);
    expect(mentionsTarget("Write the spec for plan stage 02-S31 (docs/plans/02.md).", "02-S3")).toBe(false);
  });

  it("does not read regex characters in a target as a pattern", () => {
    expect(mentionsTarget("Slice .ai/specs/aXmd", ".ai/specs/a.md")).toBe(false);
  });
});

describe("usage-limit pause", () => {
  it("recognises the engine's booked resume and Claude's envelope while its reset is ahead", () => {
    expect(isParkedOnUsageLimit(failedRun({ autoResumeAt: iso(HOUR) }), NOW)).toBe(true);
    const envelope = (resetMs) => failedRun({ error: `Claude AI usage limit reached|${Math.floor(resetMs / 1000)}` });
    expect(isParkedOnUsageLimit(envelope(NOW + HOUR), NOW)).toBe(true);
    expect(isParkedOnUsageLimit(envelope(NOW - HOUR), NOW)).toBe(false);
    expect(isParkedOnUsageLimit(failedRun(), NOW)).toBe(false);
    expect(isParkedOnUsageLimit(run({ status: "running", autoResumeAt: iso(HOUR) }), NOW)).toBe(false);
  });

  it("launches and repairs nothing while a run in ANY project is parked, but still publishes the digest", () => {
    const parked = failedRun({ autoResumeAt: iso(HOUR), task: "Implement issue #9." });
    const actions = decide(
      snapshot(
        [
          project("pt", { plan: [act("implement", "#5")], runs: [failedRun({ task: "Implement issue #7." })], receipts: [receipt()] }),
          project("cezar", { managed: false, runs: [parked] }),
        ],
        { state: { digests: { pt: "2026-10-01" } } },
      ),
    );
    expect(actions.map((a) => a.type)).toEqual(["pause", "digest"]);
  });

  it("does not repair the run that is parked: the engine resumes it itself", () => {
    const parked = failedRun({ autoResumeAt: iso(HOUR) });
    expect(isRepairCandidate(parked, [parked], NOW)).toBe(false);
  });
});

describe("capacity", () => {
  it("is the workspace cap minus the slots every registered project holds, managed or not", () => {
    const actions = decide(
      snapshot(
        [
          project("pt", { plan: [act("implement", "#1"), act("triage", "#2"), act("slice", ".ai/specs/a.md")] }),
          project("mt", { plan: [act("implement", "#3")] }),
          project("cezar", { managed: false, runs: [run({ status: "running" }), run({ status: "queued" })] }),
        ],
        { maxParallel: 4 },
      ),
    );
    expect(launches(actions)).toEqual(["pt:#1", "pt:#2"]);
    expect(ofType(actions, "skip").some((a) => /no free slot \(4 in all, 2 held, 2 started this tick\)/.test(a.reason))).toBe(true);
  });

  it("starts nothing when the workspace is full, and says why", () => {
    const busy = [run({ status: "running" }), run({ status: "running" })];
    const actions = decide(
      snapshot([project("pt", { plan: [act("implement", "#1")] }), project("cezar", { managed: false, runs: busy })], {
        maxParallel: 2,
      }),
    );
    expect(launches(actions)).toEqual([]);
    expect(ofType(actions, "skip")[0].reason).toMatch(/no free slot/);
  });

  it("lets --max-launch cap the whole tick across projects, repairs included", () => {
    const projects = [
      project("pt", { plan: [act("implement", "#1"), act("triage", "#2")] }),
      project("mt", { plan: [act("implement", "#3")] }),
    ];
    expect(launches(decide(snapshot(projects, { maxLaunch: 2 })))).toEqual(["pt:#1", "pt:#2"]);
    expect(launches(decide(snapshot(projects, { maxLaunch: 1 })))).toEqual(["pt:#1"]);

    const withRepair = [project("pt", { runs: [failedRun()], plan: [act("implement", "#9")] })];
    const actions = decide(snapshot(withRepair, { maxLaunch: 1 }));
    expect(ofType(actions, "repair")).toHaveLength(1);
    expect(launches(actions)).toEqual([]);
    expect(ofType(actions, "skip")[0].reason).toBe("--max-launch 1 reached (1 started this tick)");
  });
});

describe("launch", () => {
  it("keeps the plan's own order and starts at most one action per kind", () => {
    const plan = [act("triage", "#3"), act("triage", "#4"), act("implement", "#1")];
    const actions = decide(snapshot([project("pt", { plan })]));
    expect(launches(actions)).toEqual(["pt:#3", "pt:#1"]);
    expect(ofType(actions, "skip")[0]).toMatchObject({ subject: "triage #4", reason: "a triage run started this tick" });
  });

  // planned.travel 2026-10-04: #516 led the plan for six hours after its run ended, and #121, ready
  // behind it, never started because the first candidate of a kind was the only one tried.
  it("tries the next candidate of a kind when the first one cannot start", () => {
    const done = run({ workflow: "wf-implement", task: "Implement issue #516.", finishedAt: iso(-HOUR) });
    const plan = [act("implement", "#516"), act("implement", "#121"), act("implement", "#200")];
    const actions = decide(snapshot([project("pt", { runs: [done], plan })]));
    expect(launches(actions)).toEqual(["pt:#121"]);
    expect(ofType(actions, "skip").map((a) => a.subject)).toEqual(["implement #516", "implement #200"]);

    const owner = run({ status: "running", task: "Implement issue #516." });
    expect(launches(decide(snapshot([project("pt", { runs: [owner], plan })])))).toEqual(["pt:#121"]);
  });

  it("allows a project two active runs, counting what it launches itself", () => {
    const plan = [act("implement", "#1"), act("triage", "#2"), act("slice", "s.md")];
    expect(launches(decide(snapshot([project("pt", { plan })])))).toEqual(["pt:#1", "pt:#2"]);
    const oneBusy = project("pt", { plan, runs: [run({ status: "running", task: "A person's task." })] });
    expect(launches(decide(snapshot([oneBusy])))).toEqual(["pt:#1"]);
    const twoBusy = project("pt", { plan, runs: [run({ status: "running" }), run({ status: "queued" })] });
    const actions = decide(snapshot([twoBusy]));
    expect(launches(actions)).toEqual([]);
    expect(ofType(actions, "skip")[0].reason).toMatch(/already has 2 active runs/);
  });

  it("does not count a project's runs that hold no slot: waiting, review or monitoring", () => {
    const plan = [act("implement", "#1"), act("triage", "#2")];
    const idle = [
      run({ status: "waiting", task: "A person's chat." }),
      run({ status: "review" }),
      run({ status: "running", activity: "monitoring", task: "Watch PR #40." }),
    ];
    expect(launches(decide(snapshot([project("pt", { plan, runs: idle })])))).toEqual(["pt:#1", "pt:#2"]);
  });

  it("does not start a workflow again on a target it finished in the last 6 hours", () => {
    const triaged = run({ workflow: "wf-triage", task: "Do triage on #5.", finishedAt: iso(-HOUR) });
    const plan = [act("triage", "#5"), act("implement", "#5")];
    const actions = decide(snapshot([project("pt", { runs: [triaged], plan })]));
    expect(launches(actions)).toEqual(["pt:#5"]);
    expect(ofType(actions, "launch")[0].kind).toBe("implement");
    expect(ofType(actions, "skip")[0]).toMatchObject({ subject: "triage #5", reason: expect.stringMatching(/within 6 hours/) });
    const later = run({ workflow: "wf-triage", task: "Do triage on #5.", finishedAt: iso(-7 * HOUR) });
    expect(launches(decide(snapshot([project("pt", { runs: [later], plan: [act("triage", "#5")] })])))).toEqual(["pt:#5"]);
  });

  it("skips a target an active run already names, and not one that merely shares a prefix", () => {
    const active = run({ status: "running", task: "Implement issue #123." });
    const actions = decide(snapshot([project("pt", { runs: [active], plan: [act("implement", "#12"), act("triage", "#123")] })]));
    expect(launches(actions)).toEqual(["pt:#12"]);
    expect(ofType(actions, "skip")[0]).toMatchObject({ subject: "triage #123", reason: "a run already owns this target" });
  });

  it("does not launch again a target whose run just failed or was cancelled, until the window passes", () => {
    const failed = failedRun({ task: "Implement issue #7." });
    const cancelled = run({ status: "cancelled", task: "Implement issue #8.", finishedAt: iso(-HOUR) });
    const old = failedRun({ task: "Implement issue #9.", finishedAt: iso(-49 * HOUR), createdAt: iso(-50 * HOUR) });
    const plan = [act("implement", "#7"), act("triage", "#8"), act("slice", "#9")];
    const actions = decide(snapshot([project("pt", { runs: [failed, cancelled, old], plan })], { maxParallel: 9 }));
    expect(launches(actions)).toEqual(["pt:#9"]);
  });

  it("launches nothing for a project whose plan is unavailable", () => {
    const actions = decide(snapshot([project("mt", { plan: null }), project("pt", { plan: [act("implement", "#1")] })]));
    expect(launches(actions)).toEqual(["pt:#1"]);
  });

  it("never acts on a project it does not manage", () => {
    const other = project("cezar", { managed: false, plan: [act("implement", "#1")], runs: [failedRun()] });
    expect(decide(snapshot([other]))).toEqual([]);
  });

  it("does not launch the target it is repairing in the same tick", () => {
    const failed = failedRun({ task: "Implement issue #7." });
    const actions = decide(snapshot([project("pt", { runs: [failed], plan: [act("implement", "#7"), act("triage", "#8")] })]));
    expect(ofType(actions, "repair")).toHaveLength(1);
    expect(launches(actions)).toEqual(["pt:#8"]);
  });
});

describe("pull requests", () => {
  const pr = (over = {}) => ({
    number: 877,
    baseRefName: "develop",
    headRefName: "spec/a-calendar",
    headRefOid: "0867e849",
    isDraft: false,
    isCrossRepository: false,
    mergeable: "MERGEABLE",
    author: { login: "rafalwolak", is_bot: false },
    labels: [],
    behindBy: 2,
    ...over,
  });
  const tick = (prs, over = {}) => decide(snapshot([project("pt", { prs, ...over.project })], over));
  const skips = (actions) => ofType(actions, "skip").map((action) => `${action.subject}: ${action.reason}`);
  // How the PR automations name a pull request: `{{github.number}}`, then the event context.
  const prTask = (number) => `${number}\n\n---\nGitHub event context (untrusted data)\nnumber: ${number}`;

  it("merges the base into a pull request behind it, with no slot, cap or open usage window", () => {
    const update = { type: "update-branch", project: "pt", number: 877, head: "0867e849", base: "develop", behindBy: 2 };
    expect(ofType(tick([pr()]), "update-branch")).toEqual([update]);
    expect(ofType(tick([pr()], { maxLaunch: 0, maxParallel: 0 }), "update-branch")).toEqual([update]);
    const parked = failedRun({ error: "Claude AI usage limit reached|" + String(Math.floor((NOW + HOUR) / 1000)) });
    const paused = tick([pr()], { project: { runs: [parked] } });
    expect(ofType(paused, "pause")).toHaveLength(1);
    expect(ofType(paused, "update-branch")).toEqual([update]);
  });

  // design4pro 2026-10-05: two CI runners, and every merge into develop queued a full CI run on
  // each open pull request, including the ones QA has not signed off yet. design4pro 2026-10-06:
  // #798 (risk-high) and #880 (security) sat behind develop for good, so only QA still waits.
  it("updates a pull request that waits for QA only once QA has answered", () => {
    const waiting = pr({ number: 779, labels: [{ name: "needs-qa" }] });
    expect(tick([waiting], { project: { plan: [] } })).toEqual([]);
    const answered = pr({ number: 779, labels: [{ name: "needs-qa" }, { name: "qa-approved" }] });
    expect(ofType(tick([answered]), "update-branch").map((a) => a.number)).toEqual([779]);
  });

  it("updates a risk-high or security pull request like any other", () => {
    const risky = [
      pr({ number: 798, labels: [{ name: "risk-high" }] }),
      pr({ number: 880, labels: [{ name: "security" }] }),
    ];
    expect(ofType(tick(risky), "update-branch").map((a) => a.number)).toEqual([798, 880]);
  });

  it("leaves alone a current pull request, a draft, a fork's and a bot's, without a log line", () => {
    const prs = [
      pr({ number: 1, behindBy: 0 }),
      pr({ number: 2, isDraft: true }),
      pr({ number: 3, isCrossRepository: true }),
      pr({ number: 4, author: { login: "app/dependabot", is_bot: true }, mergeable: "CONFLICTING" }),
    ];
    expect(tick(prs, { project: { plan: [] } })).toEqual([]);
  });

  it("does not move a branch a label or a working run holds", () => {
    const opener = run({ id: "fb31d19c-0000-4000-8000-000000000000", status: "running", task: "Implement issue #516." });
    const autopilot = run({ status: "running", workflow: "pr-autopilot", task: prTask(878) });
    const actions = tick(
      [
        pr({ number: 876, labels: [{ name: "in-progress" }] }),
        pr({ number: 877, headRefName: "cez/fb31d19c" }),
        pr({ number: 878, mergeable: "CONFLICTING" }),
        pr({ number: 879, mergeable: "UNKNOWN" }),
      ],
      { project: { runs: [opener, autopilot] } },
    );
    expect(ofType(actions, "update-branch")).toEqual([]);
    expect(launches(actions)).toEqual([]);
    expect(skips(actions)).toEqual([
      "pull request #876: labelled in-progress",
      "pull request #877: a run is working on it",
      "pull request #878: a run is working on it",
      "pull request #879: GitHub has not settled its mergeability (UNKNOWN)",
    ]);
  });

  // planned.travel 2026-10-05: #875 merged a line into `.ai/specs/README.md` that #877 also
  // wrote, and #877 sat conflicting with nothing to start on it.
  it("starts pr-autopilot on a conflict ahead of the plan, once per tick", () => {
    const plan = [act("implement", "#121")];
    const prs = [pr({ mergeable: "CONFLICTING" }), pr({ number: 880, mergeable: "CONFLICTING" })];
    const actions = tick(prs, { project: { plan } });
    expect(ofType(actions, "launch")[0]).toMatchObject({
      kind: "resolve-conflicts",
      target: "#877",
      workflow: "pr-autopilot",
      task: "877",
    });
    expect(launches(actions)).toEqual(["pt:#877", "pt:#121"]);
    expect(skips(actions)).toEqual(["resolve-conflicts #880: a resolve-conflicts run started this tick"]);
    expect(launches(tick(prs, { project: { plan }, maxLaunch: 1 }))).toEqual(["pt:#877"]);
  });

  const rollup = (conclusion) => [
    { __typename: "CheckRun", name: "unit", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", name: "e2e", workflowName: "CI", status: "COMPLETED", conclusion },
  ];

  // planned.travel 2026-10-05: #779 failed its own e2e journeys, got `qa-approved` by hand, and no
  // event started anything on it: the automations fire on `opened` and `reviewed` only.
  it("starts pr-autopilot on a red pull request, and on a green one that waits on nobody", () => {
    const red = pr({ number: 779, behindBy: 0, statusCheckRollup: rollup("FAILURE") });
    const green = pr({
      number: 781,
      behindBy: 0,
      statusCheckRollup: rollup("SUCCESS"),
      labels: [{ name: "needs-qa" }, { name: "qa-approved" }, { name: "risk-medium" }],
    });
    const actions = tick([red, green], { project: { plan: [act("implement", "#121")] } });
    expect(ofType(actions, "launch").map((a) => `${a.kind} ${a.target} ${a.workflow} ${a.task}`)).toEqual([
      "merge #781 pr-autopilot 781",
      "fix-checks #779 pr-autopilot 779",
    ]);
  });

  it("merges a green risk-high pull request, and leaves one waiting for QA, one still running, and one behind to update", () => {
    const prs = [
      pr({ number: 1, behindBy: 0, statusCheckRollup: rollup("SUCCESS"), labels: [{ name: "risk-high" }] }),
      pr({ number: 2, behindBy: 0, statusCheckRollup: rollup("SUCCESS"), labels: [{ name: "needs-qa" }] }),
      pr({ number: 3, behindBy: 0, statusCheckRollup: rollup("").map((c) => ({ ...c, status: "QUEUED" })) }),
      pr({ number: 4, behindBy: 3, statusCheckRollup: rollup("FAILURE") }),
    ];
    const actions = tick(prs);
    expect(launches(actions)).toEqual(["pt:#1"]);
    expect(ofType(actions, "update-branch").map((a) => a.number)).toEqual([4]);
  });

  it("waits on a conflict a pr-autopilot run just settled, or a run failed on", () => {
    const conflict = [pr({ mergeable: "CONFLICTING" })];
    const done = run({ workflow: "pr-autopilot", task: prTask(877), finishedAt: iso(-HOUR) });
    expect(skips(tick(conflict, { project: { runs: [done] } }))).toEqual([
      "pull request #877: a pr-autopilot run finished on it within 6 hours",
    ]);
    const failed = failedRun({ workflow: "pr-autopilot", task: prTask(877), finishedAt: iso(-HOUR) });
    expect(skips(tick(conflict, { project: { runs: [failed] } }))[0]).toBe(
      "pull request #877: a run on it failed or was cancelled in the last 48 hours",
    );
    const old = run({ workflow: "pr-autopilot", task: prTask(877), finishedAt: iso(-7 * HOUR) });
    expect(launches(tick(conflict, { project: { runs: [old] } }))).toEqual(["pt:#877"]);
  });
});

describe("checksState", () => {
  const check = (name, conclusion, over = {}) => ({
    __typename: "CheckRun",
    name,
    workflowName: "CI",
    status: "COMPLETED",
    conclusion,
    startedAt: "2026-10-05T09:00:00Z",
    ...over,
  });

  it("reads a failure, a running check, and a skipped one as a pass", () => {
    expect(checksState([])).toBeNull();
    expect(checksState([check("unit", "SUCCESS"), check("e2e", "SKIPPED")])).toBe("passed");
    expect(checksState([check("unit", "SUCCESS"), check("e2e", "FAILURE")])).toBe("failed");
    expect(checksState([check("unit", "SUCCESS"), check("e2e", "", { status: "IN_PROGRESS" })])).toBe("pending");
    expect(checksState([{ __typename: "StatusContext", context: "deploy", state: "ERROR" }])).toBe("failed");
  });

  it("counts a check that ran twice on one head by its latest run", () => {
    const failed = check("e2e", "FAILURE", { startedAt: "2026-10-05T09:00:00Z" });
    const rerun = check("e2e", "SUCCESS", { startedAt: "2026-10-05T10:00:00Z" });
    expect(checksState([failed, rerun])).toBe("passed");
    expect(checksState([rerun, failed])).toBe("passed");
  });
});

describe("repair ladder", () => {
  const repairs = (runs, state = {}, over = {}) =>
    ofType(decide(snapshot([project("pt", { runs })], { state, ...over })), "repair");

  it("continues a run that has a session, relaunches one that never had one", () => {
    const withSession = failedRun();
    const without = failedWithoutSession();
    const [first, second] = repairs([withSession, without]);
    expect([first.mode, second.mode].sort()).toEqual(["continue", "relaunch"]);
    expect(first.attempt).toBe(1);
  });

  it("treats a session the provider no longer has as no session", () => {
    const lost = failedRun({ error: "continue failed: claude CLI exited with code 1 — No conversation found with session ID: 6f517f63" });
    expect(hasSession(lost)).toBe(false);
    expect(repairs([lost])[0].mode).toBe("relaunch");
  });

  it("counts attempts per run id and gives each run two", () => {
    const failed = failedRun();
    const at = iso(-HOUR);
    expect(repairs([failed])[0].attempt).toBe(1);
    expect(repairs([failed], { repairs: { [failed.id]: { attempts: 1, at } } })[0].attempt).toBe(2);
    expect(repairs([failed], { repairs: { [failed.id]: { attempts: 2, at } } })).toEqual([]);
  });

  it("asks for a root-cause pass on attempt 2 only", () => {
    const failed = failedRun();
    expect(recoveryText(failed, 1)).not.toMatch(/root-cause/);
    expect(recoveryText(failed, 2)).toMatch(/independent root-cause specialist sub-agent through the Agent tool/);
    expect(recoveryText(failed, 1)).toContain(
      "Step `implement` failed: step \"implement\" failed: the agent exploded.",
    );
    expect(recoveryText(failed, 1)).toContain("Finish step `implement` and then every later step of `.ai/cezar/workflows/implement-ticket.yml`");
    expect(recoveryText(failed, 1)).toContain("End with your done signal.");
  });

  it("names the failed workflow step, never the engine's own continue-N step", () => {
    const failed = failedRun({
      steps: [
        { id: "implement", status: "done", sessionId: "s" },
        { id: "gate", status: "failed" },
        { id: "continue-1", status: "failed", sessionId: "s2" },
      ],
    });
    expect(recoveryText(failed, 1)).toContain("Finish step `gate`");
  });

  it("escalates once after two attempts, to the issue the task names, else the discovered one, else nobody", () => {
    const at = iso(-HOUR);
    const spent = (over) => {
      const failed = failedRun(over);
      return { failed, state: { repairs: { [failed.id]: { attempts: 2, at } } } };
    };
    const named = spent({ task: "Implement issue #42 (https://x/y/issues/7).", issueNumber: 7 });
    const [escalation] = ofType(decide(snapshot([project("pt", { runs: [named.failed] })], { state: named.state })), "escalate");
    expect(escalation.issue).toBe(42);

    expect(targetIssue(failedRun({ task: "750\n\n---\ncontext", issueNumber: 734 }))).toBe(734);
    expect(targetIssue(failedRun({ task: "housekeeping" }))).toBeNull();

    const done = spent({});
    done.state.repairs[done.failed.id].escalated = true;
    expect(ofType(decide(snapshot([project("pt", { runs: [done.failed] })], { state: done.state })), "escalate")).toEqual([]);
  });

  it("writes the escalation the way the unblock sweep reads it", () => {
    const failed = failedRun({ id: "abcdef12-0000-0000-0000-000000000000", error: "check \"gate\" failed." });
    expect(escalationComment(failed)).toBe(
      '🤖 HUMAN-ONLY: the unattended implement-ticket task abcdef12 failed again after two automatic repairs: check "gate" failed. Read it in the cockpit, then remove `blocked`.',
    );
  });

  it("leaves a run to a person when repeating it cannot help", () => {
    for (const error of [
      "`claude` not found on PATH — install Claude Code",
      "Claude credentials are unavailable. Authorize it in Settings → Agents → Providers.",
      "unknown workflow: pr-autopilot",
    ]) {
      const failed = failedRun({ error });
      expect(nonRetryableReason(failed)).toBeTruthy();
      const actions = decide(snapshot([project("pt", { runs: [failed] })]));
      expect(ofType(actions, "repair")).toEqual([]);
      expect(ofType(actions, "skip")[0].reason).toMatch(/^not retryable/);
    }
    expect(nonRetryableReason(failedRun({ error: "Failed to refresh OAuth token: another Claude Code process is refreshing it" }))).toBeNull();
  });

  it("will not relaunch an inline chain it has no file for", () => {
    const planned = failedWithoutSession({ workflow: "(planned)" });
    const actions = decide(snapshot([project("pt", { runs: [planned] })]));
    expect(ofType(actions, "repair")).toEqual([]);
    expect(ofType(actions, "skip")[0].reason).toMatch(/inline chain/);
  });

  it("only repairs unattended, recent, unarchived failures", () => {
    const base = failedRun();
    expect(isRepairCandidate(base, [base], NOW)).toBe(true);
    expect(isRepairCandidate({ ...base, autonomous: false }, [base], NOW)).toBe(false);
    expect(isRepairCandidate({ ...base, status: "cancelled" }, [base], NOW)).toBe(false);
    expect(isRepairCandidate({ ...base, archived: true }, [base], NOW)).toBe(false);
    expect(isRepairCandidate({ ...base, finishedAt: iso(-49 * HOUR) }, [base], NOW)).toBe(false);
    expect(isRepairCandidate({ ...base, finishedAt: undefined, createdAt: undefined }, [base], NOW)).toBe(false);
  });

  it("repairs only the newest run of a workflow and task: a newer run has taken the work over", () => {
    const older = failedRun({ workflow: "housekeeping", task: "housekeeping", createdAt: iso(-10 * HOUR) });
    const newer = failedRun({ workflow: "housekeeping", task: "housekeeping", createdAt: iso(-4 * HOUR) });
    expect(repairs([older, newer]).map((a) => a.run.id)).toEqual([newer.id]);
    const recovered = run({ workflow: "housekeeping", task: "housekeeping", createdAt: iso(-HOUR) });
    expect(repairs([older, newer, recovered])).toEqual([]);
    const cancelledSince = run({ status: "cancelled", workflow: "housekeeping", task: "housekeeping", createdAt: iso(-HOUR) });
    expect(repairs([newer, cancelledSince])).toEqual([]);
  });

  it("spends one unit of capacity per repair, oldest failure first", () => {
    const oldest = failedRun({ task: "Implement issue #1.", finishedAt: iso(-5 * HOUR) });
    const newest = failedRun({ task: "Implement issue #2.", finishedAt: iso(-1 * HOUR) });
    const actions = decide(snapshot([project("pt", { runs: [newest, oldest] })], { maxParallel: 1 }));
    expect(ofType(actions, "repair").map((a) => a.run.id)).toEqual([oldest.id]);
    expect(ofType(actions, "skip")[0].reason).toMatch(/no free slot/);
  });

  it("retries a launch-error receipt once, and not one that is old, launched or already retried", () => {
    const state = { ...emptyState(), retriedReceipts: { done: iso(-HOUR) } };
    const receipts = [
      receipt({ receiptId: "fresh" }),
      receipt({ receiptId: "old", updatedAt: iso(-49 * HOUR) }),
      receipt({ receiptId: "launched", status: "launched", runId: "r1" }),
      receipt({ receiptId: "done" }),
    ];
    expect(retryableReceipts(receipts, NOW, state).map((r) => r.receiptId)).toEqual(["fresh"]);
    const actions = decide(snapshot([project("pt", { receipts })], { state }));
    expect(ofType(actions, "retry-receipt").map((a) => a.receipt.receiptId)).toEqual(["fresh"]);
  });

  it("reads the newest line of each receipt as its state", () => {
    const lines = [
      JSON.stringify({ receiptKey: "a", status: "reserved" }),
      JSON.stringify({ receiptKey: "b", status: "launched", runId: "r" }),
      JSON.stringify({ receiptKey: "a", status: "launch-error" }),
      '{"receiptKey":"c","sta',
    ].join("\n");
    const latest = latestReceipts(lines);
    expect(latest.map((r) => r.status).sort()).toEqual(["launch-error", "launched"]);
  });
});

describe("digest", () => {
  const due = (digests) => ofType(decide(snapshot([project("pt")], { state: { digests } })), "digest");

  it("is due on the first tick at or after 07:00 Warsaw, once per Warsaw day", () => {
    // 2026-10-02 is CEST (UTC+2): 07:00 in Warsaw is 05:00Z.
    expect(digestDue(Date.parse("2026-10-02T04:59:00Z"), "2026-10-01")).toBe(false);
    expect(digestDue(Date.parse("2026-10-02T05:00:00Z"), "2026-10-01")).toBe(true);
    expect(digestDue(Date.parse("2026-10-02T05:00:00Z"), undefined)).toBe(true);
    expect(digestDue(Date.parse("2026-10-02T17:00:00Z"), "2026-10-02")).toBe(false);
  });

  it("follows Warsaw across both clock changes, whatever zone the host runs in", () => {
    // Summer time began 2026-03-29 at 01:00Z; ended 2026-10-25 at 01:00Z.
    expect(digestDue(Date.parse("2026-03-28T05:59:00Z"), "")).toBe(false); // CET, 06:59
    expect(digestDue(Date.parse("2026-03-28T06:00:00Z"), "")).toBe(true); // CET, 07:00
    expect(digestDue(Date.parse("2026-03-29T04:59:00Z"), "")).toBe(false); // CEST, 06:59
    expect(digestDue(Date.parse("2026-03-29T05:00:00Z"), "")).toBe(true); // CEST, 07:00
    expect(digestDue(Date.parse("2026-10-24T05:00:00Z"), "")).toBe(true); // CEST, 07:00
    expect(digestDue(Date.parse("2026-10-26T05:59:00Z"), "")).toBe(false); // CET, 06:59
    expect(digestDue(Date.parse("2026-10-26T06:00:00Z"), "")).toBe(true); // CET, 07:00
  });

  it("starts a new day at Warsaw midnight, not at UTC midnight", () => {
    expect(warsawClock(Date.parse("2026-10-02T21:59:00Z"))).toEqual({ date: "2026-10-02", hour: 23 });
    expect(warsawClock(Date.parse("2026-10-02T22:00:00Z"))).toEqual({ date: "2026-10-03", hour: 0 });
    // 00:30 Warsaw on the 3rd is a new day with no digest yet, but it is not 07:00.
    expect(digestDue(Date.parse("2026-10-02T22:30:00Z"), "2026-10-02")).toBe(false);
    expect(digestDue(Date.parse("2026-10-03T05:00:00Z"), "2026-10-02")).toBe(true);
  });

  it("is decided per project from the state's last date", () => {
    expect(due({ pt: "2026-10-01" })).toHaveLength(1);
    expect(due({ pt: "2026-10-02" })).toHaveLength(0);
  });

  it("lists what waits for a person and the day's pulse", () => {
    const failed = failedRun({ id: "aaaaaaaa-1", error: "`claude` not found on PATH" });
    const escalated = failedRun({ id: "bbbbbbbb-2", workflow: "triage", error: 'check "bootstrap" failed' });
    const retrying = failedRun({ id: "cccccccc-3" });
    const stale = failedRun({ id: "dddddddd-4", error: "unknown workflow: x", finishedAt: iso(-30 * HOUR) });
    const done = run({ id: "eeeeeeee-5", task: "Triage issue #5 (https://x)\nmore" });
    const body = digestBody({
      now: NOW,
      issues: [
        { number: 3, title: "A hold", url: "https://x/3", state: "BLOCKED" },
        { number: 4, title: "Another", url: "https://x/4", state: "BLOCKED" },
        { number: 5, title: "Ready", url: "https://x/5", state: "READY" },
      ],
      prs: [
        { number: 10, title: "needs a person", url: "https://x/10", labels: [{ name: "needs-qa" }] },
        { number: 11, title: "approved", url: "https://x/11", labels: [{ name: "needs-qa" }, { name: "qa-approved" }] },
        { number: 12, title: "plain", url: "https://x/12", labels: [] },
        { number: 13, title: "sensitive", url: "https://x/13", labels: [{ name: "security" }, { name: "risk-high" }] },
      ],
      runs: [failed, escalated, retrying, stale, done],
      state: { ...emptyState(), repairs: { [escalated.id]: { attempts: 2, at: iso(-HOUR), escalated: true } } },
    });
    expect(body).toContain("| BLOCKED | 2 |");
    expect(body).toContain("| READY | 1 |");
    expect(body).toContain("[#3](https://x/3) A hold");
    expect(body).toContain("[#10](https://x/10) needs a person: needs-qa");
    expect(body).not.toContain("sensitive");
    expect(body).not.toContain("approved");
    expect(body).not.toContain("plain");
    expect(body).toContain("### Escalated or not retryable (2)");
    expect(body).toContain("`aaaaaaaa` implement-ticket");
    expect(body).toContain("`bbbbbbbb` triage");
    expect(body).not.toContain("cccccccc");
    expect(body).not.toContain("dddddddd");
    expect(body).toContain("### Done (1)");
    expect(body).toContain("`eeeeeeee` implement-ticket: Triage issue #5 (https://x)");
  });
});

describe("sync guard", () => {
  const states = { enabled: { nextCheckAt: iso(30_000) }, gone: { nextCheckAt: iso(1_000) }, later: { nextCheckAt: iso(5 * 60_000) } };

  it("blocks on an enabled automation polling within 10 s, on either side of now", () => {
    expect(imminentPoll({ x: { nextCheckAt: iso(8_000) } }, new Set(["x"]), NOW)).toBe("x");
    expect(imminentPoll({ x: { nextCheckAt: iso(-8_000) } }, new Set(["x"]), NOW)).toBe("x");
    expect(imminentPoll({ x: { nextCheckAt: iso(11_000) } }, new Set(["x"]), NOW)).toBeNull();
  });

  // Run b6eb30ef's tick and every later one skipped the sync: two automations poll every 60 s, so
  // one was always within the old 60 s margin and a merged change never reached the checkout.
  it("waits for a quiet moment instead of giving up on the first busy one", () => {
    let now = NOW;
    const result = waitForQuietPoll({
      states: () => ({ x: { nextCheckAt: iso(5_000) } }),
      enabledIds: new Set(["x"]),
      now: () => now,
      sleep: (ms) => {
        now += ms;
      },
    });
    expect(result).toBeNull();
    expect(now - NOW).toBeGreaterThan(5_000 + 10_000);
    expect(now - NOW).toBeLessThan(2 * 60_000);
  });

  it("gives up after two minutes and names the automation", () => {
    let now = NOW;
    const result = waitForQuietPoll({
      states: () => ({ x: { nextCheckAt: new Date(now + 1_000).toISOString() } }),
      enabledIds: new Set(["x"]),
      now: () => now,
      sleep: (ms) => {
        now += ms;
      },
    });
    expect(result).toBe("x");
    expect(now - NOW).toBeGreaterThanOrEqual(2 * 60_000);
  });

  it("ignores a state for an automation that is not enabled", () => {
    expect(imminentPoll(states, new Set(["later"]), NOW)).toBeNull();
    expect(imminentPoll(undefined, new Set(), NOW)).toBeNull();
  });
});

describe("state file", () => {
  it("degrades to empty on anything it cannot read", () => {
    for (const raw of [null, undefined, "x", [], 5, { repairs: "no" }]) {
      expect(normalizeState(raw)).toEqual(emptyState());
    }
  });

  it("keeps well-formed entries and drops the rest one by one", () => {
    const state = normalizeState({
      repairs: { good: { attempts: 1, at: "2026-10-01T00:00:00Z", escalated: true }, bad: { attempts: "1" }, worse: 3 },
      retriedReceipts: { a: "2026-10-01T00:00:00Z", b: 4 },
      digests: { pt: "2026-10-02", mt: 1 },
    });
    expect(state).toEqual({
      repairs: { good: { attempts: 1, at: "2026-10-01T00:00:00Z", escalated: true } },
      retriedReceipts: { a: "2026-10-01T00:00:00Z" },
      digests: { pt: "2026-10-02" },
    });
  });

  it("forgets runs and receipts older than two weeks, never a digest date", () => {
    const state = pruneState(
      {
        repairs: { old: { attempts: 2, at: iso(-15 * 24 * HOUR) }, fresh: { attempts: 1, at: iso(-HOUR) } },
        retriedReceipts: { old: iso(-15 * 24 * HOUR), fresh: iso(-HOUR) },
        digests: { pt: "2026-09-01" },
      },
      NOW,
    );
    expect(Object.keys(state.repairs)).toEqual(["fresh"]);
    expect(Object.keys(state.retriedReceipts)).toEqual(["fresh"]);
    expect(state.digests).toEqual({ pt: "2026-09-01" });
  });
});

describe("the plan contract", () => {
  it("reads the actions and refuses a malformed one rather than launching part of a plan", () => {
    const action = { kind: "implement", target: "#1", workflow: "implement-ticket", task: "Implement issue #1." };
    expect(parsePlan(JSON.stringify({ wip: { limit: 3 }, actions: [action] }))).toEqual([action]);
    expect(parsePlan(JSON.stringify({ actions: [] }))).toEqual([]);
    expect(() => parsePlan("not json")).toThrow();
    expect(() => parsePlan(JSON.stringify({ wip: {} }))).toThrow(/actions array/);
    expect(() => parsePlan(JSON.stringify({ actions: [{ ...action, workflow: "" }] }))).toThrow(/no workflow/);
  });
});

describe("parseArgs", () => {
  it("reads projects in the order given, and the two flags", () => {
    const options = parseArgs(["--project", "a=/tmp/a", "--project", "b=/tmp/b", "--dry-run", "--max-launch", "3"]);
    expect(options.projects).toEqual([{ id: "a", root: "/tmp/a" }, { id: "b", root: "/tmp/b" }]);
    expect(options.dryRun).toBe(true);
    expect(options.maxLaunch).toBe(3);
    expect(parseArgs(["--project", "a=/tmp/a"])).toMatchObject({ dryRun: false, maxLaunch: Infinity });
  });

  it("throws on anything else, so a typo on the cron line is as red as a failure", () => {
    expect(() => parseArgs(["--project", "a=/tmp/a", "--dryrun"])).toThrow(/unknown argument --dryrun/);
    expect(() => parseArgs([])).toThrow(/--project is required/);
    expect(() => parseArgs(["--project", "nopath"])).toThrow(/<id>=<path>/);
    expect(() => parseArgs(["--project", "a="])).toThrow(/<id>=<path>/);
    expect(() => parseArgs(["--project", "a=/x", "--project", "a=/y"])).toThrow(/twice/);
    expect(() => parseArgs(["--project", "a=/x", "--max-launch", "0"])).toThrow(/positive/);
    expect(() => parseArgs(["--project", "a=/x", "--max-launch"])).toThrow(/positive/);
  });
});

describe("parseGithubRepo", () => {
  it("reads owner/repo from an ssh or https remote", () => {
    expect(parseGithubRepo("git@github.com:design4pro/planned.travel.git\n")).toBe("design4pro/planned.travel");
    expect(parseGithubRepo("https://github.com/design4pro/money-tracker.online.git")).toBe("design4pro/money-tracker.online");
    expect(parseGithubRepo("https://github.com/design4pro/cezar")).toBe("design4pro/cezar");
    expect(parseGithubRepo("git@gitlab.com:a/b.git")).toBeNull();
  });
});

describe("describe", () => {
  it("says every decision on one line", () => {
    const failed = failedRun({ id: "abcdef12-x" });
    const lines = [
      describeAction({ type: "pause", reason: "r" }),
      describeAction({ type: "skip", subject: "s", reason: "r" }),
      describeAction({ type: "retry-receipt", receipt: receipt() }),
      describeAction({ type: "repair", mode: "continue", run: failed, attempt: 1 }),
      describeAction({ type: "escalate", run: failed, issue: 4 }),
      describeAction({ type: "escalate", run: failed, issue: null }),
      describeAction({ type: "launch", kind: "implement", target: "#1", workflow: "implement-ticket" }),
      describeAction({ type: "digest" }),
      describeAction({ type: "update-branch", number: 877, head: "0867e849", base: "develop", behindBy: 2 }),
    ];
    for (const line of lines) expect(line).not.toContain("\n");
    expect(lines[3]).toBe('continue abcdef12 (implement-ticket) attempt 1: step "implement" failed: the agent exploded');
    expect(lines[4]).toContain("blocked + HUMAN-ONLY on #4");
    expect(lines[5]).toContain("digest only");
    expect(lines[8]).toBe("update-branch #877: 2 commit(s) behind develop, merging it in");
  });
});

describe("createApi", () => {
  // The cockpit closes an idle keep-alive socket after 5 s, and a tick runs `backlog-status.mjs`
  // for longer than that between two calls: `fetch` then reuses the dead socket and throws
  // `UND_ERR_SOCKET` before the request reaches the server.
  const staleSocket = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } });
  const ok = () => new Response("[]", { status: 200 });

  it("sends a request again once when the socket it reused was already closed", async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (calls.length === 1) throw staleSocket();
      return ok();
    };
    const response = await createApi("http://cockpit", fetchImpl).get("/api/v1/p/cezar/runs");
    expect(response).toMatchObject({ ok: true, status: 200, json: [] });
    expect(calls).toEqual(["http://cockpit/api/v1/p/cezar/runs", "http://cockpit/api/v1/p/cezar/runs"]);
  });

  it("does not retry any other failure, and gives up after the second closed socket", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    let calls = 0;
    await expect(
      createApi("http://cockpit", async () => {
        calls += 1;
        throw refused;
      }).post("/api/v1/p/x/runs", {}),
    ).rejects.toBe(refused);
    expect(calls).toBe(1);

    calls = 0;
    await expect(
      createApi("http://cockpit", async () => {
        calls += 1;
        throw staleSocket();
      }).get("/x"),
    ).rejects.toThrow("fetch failed");
    expect(calls).toBe(2);
  });
});
