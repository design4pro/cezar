/**
 * The pure half of `backlog-status.mjs` is the whole judgement: everything around it is one `gh`
 * read and a print. What can go wrong here is never an exit code, it is advice - telling a
 * developer to triage an issue whose work is already on an open pull request, or to add a closing
 * keyword to a pull request that deliberately does not close its issue.
 *
 * Both of those shipped once and are pinned below: `linkOpenPrs` keeps *which* signal matched, and
 * a branch-only link is a question rather than an instruction.
 *
 * Since ADR 0008 the same judgement is also a pick: `--next` names the issue a scheduled run
 * implements with nobody watching, so the cases that keep an issue OUT of READY - an author no
 * automation trusts, a brief a stranger wrote, an open blocker, the WIP limit - matter most.
 */

import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  WIP_LIMIT,
  blockedBy,
  branchIssue,
  classify,
  closeKeywordTargets,
  countWip,
  linkOpenPrs,
  parseArgs,
  pickNext,
  readAutomations,
  readTrusted,
  sortIssues,
} from "../backlog-status.mjs";

const NOW = Date.parse("2026-09-13T12:00:00Z");
const OWNER = { login: "rafalwolak" };

const AUTOMATIONS = [
  { name: "Groom", events: ["issue.opened"], filters: { authors: ["rafalwolak"] } },
  { name: "Ungated", events: ["issue.labeled"], filters: {} },
  { name: "Autopilot", events: ["pull_request.opened"], filters: { authors: ["someone-else"] } },
];

const trusted = new Set(["rafalwolak"]);

const sdlcLabels = {
  category: ["bug", "feature"],
  priority: ["priority-low", "priority-medium", "priority-high"],
  risk: ["risk-low", "risk-high"],
};

const BRIEF = "## Agent Brief\n\n**Category:** bug";
const agent = (body, createdAt = "2026-09-01T00:00:00Z") => ({ body: `🤖 ${body}`, createdAt, author: OWNER });
const human = (body, createdAt = "2026-09-02T00:00:00Z", author = OWNER) => ({ body, createdAt, author });

const issue = (over = {}) => ({
  number: 42,
  title: "an issue",
  author: OWNER,
  labels: [{ name: "bug" }, { name: "priority-medium" }, { name: "risk-low" }],
  comments: [agent(`triage\n\n${BRIEF}`)],
  body: "",
  updatedAt: "2026-09-13T11:00:00Z",
  ...over,
});

const decide = (over = {}, context = {}) =>
  classify(issue(over), {
    trusted,
    sdlcLabels,
    openIssues: new Set(),
    runs: new Map(),
    prLinks: new Map(),
    staleHours: 24,
    now: NOW,
    ...context,
  });

describe("readTrusted", () => {
  it("trusts the authors gating an issue automation", () => {
    expect(readTrusted(AUTOMATIONS)).toEqual(new Set(["rafalwolak"]));
  });

  it("trusts nobody when no issue automation is gated", () => {
    expect(readTrusted([AUTOMATIONS[1]]).size).toBe(0);
  });

  it("finds the maintainer in this repository's committed automations", () => {
    const dir = fileURLToPath(new URL("../../automations", import.meta.url));
    expect(readTrusted(readAutomations(dir))).toEqual(new Set(["rafalwolak"]));
  });
});

describe("closeKeywordTargets", () => {
  it("reads every English closing keyword", () => {
    expect(closeKeywordTargets("Closes #163")).toEqual([163]);
    expect(closeKeywordTargets("fixes #12 and resolved #13")).toEqual([12, 13]);
  });

  it("ignores a bare mention, which is not a link", () => {
    expect(closeKeywordTargets("follow-up to #12")).toEqual([]);
    expect(closeKeywordTargets("refs #12")).toEqual([]);
  });

  it("refuses a keyword that is only the tail of a longer word", () => {
    expect(closeKeywordTargets("discloses #9")).toEqual([]);
  });

  it("does not read a keyword quoted as code", () => {
    expect(closeKeywordTargets("write `Closes #7` in the body")).toEqual([]);
    expect(closeKeywordTargets("```\nCloses #7\n```")).toEqual([]);
  });
});

describe("branchIssue", () => {
  it("reads the issue out of any type prefix, not a fixed list", () => {
    expect(branchIssue("fix/issue-189-e2e-wedge")).toBe(189);
    expect(branchIssue("refactor/issue-184-migrations")).toBe(184);
  });

  it("is null for a branch that claims no issue", () => {
    expect(branchIssue("develop")).toBeNull();
    expect(branchIssue("chore/backlog-status-command")).toBeNull();
    expect(branchIssue("")).toBeNull();
  });
});

describe("linkOpenPrs", () => {
  it("keeps which signal matched, so a branch-only link stays distinguishable", () => {
    const links = linkOpenPrs([
      { number: 269, title: "fix(i18n): date ranges (#163)", body: "Closes #163", headRefName: "fix/issue-163-dates" },
      { number: 268, title: "fix(e2e): name the wedge", body: "This PR does not stop the wedge.", headRefName: "fix/issue-189-e2e-wedge" },
    ]);
    expect(links.get(163)).toEqual([{ number: 269, title: expect.any(String), viaKeyword: true }]);
    expect(links.get(189)).toEqual([{ number: 268, title: expect.any(String), viaKeyword: false }]);
  });

  it("records a pull request once when both signals name the same issue", () => {
    const links = linkOpenPrs([
      { number: 7, title: "t", body: "Fixes #5", headRefName: "feat/issue-5-thing" },
    ]);
    expect(links.get(5)).toHaveLength(1);
    expect(links.get(5)[0].viaKeyword).toBe(true);
  });

  it("links an issue the body closes but the branch does not name", () => {
    const links = linkOpenPrs([
      { number: 8, title: "t", body: "Closes #5\nCloses #6", headRefName: "feat/issue-5-thing" },
    ]);
    expect(links.get(6)).toEqual([{ number: 8, title: "t", viaKeyword: true }]);
  });
});

describe("blockedBy", () => {
  it("reads the issues under the ticket's Blocked by heading, up to the next heading", () => {
    expect(blockedBy("## Acceptance\n- see #3\n\n## Blocked by\n- #12\n- #13\n\n## Notes\n#99")).toEqual([12, 13]);
  });

  it("lists nothing for a ticket that can start immediately, or has no section", () => {
    expect(blockedBy("## Blocked by\n- None - can start immediately")).toEqual([]);
    expect(blockedBy("fixes a thing, see #4")).toEqual([]);
  });
});

describe("classify", () => {
  it("puts a hold ahead of everything, including a claim", () => {
    for (const hold of ["blocked", "do-not-merge", "do-not-close"]) {
      const seen = decide({ labels: [{ name: hold }, { name: "in-progress" }] });
      expect(seen.state).toBe("BLOCKED");
      expect(seen.next).toContain(hold);
    }
  });

  it("reads a fresh claim as running and a stale one as stuck", () => {
    expect(decide({ labels: [{ name: "in-progress" }] }).state).toBe("RUNNING");
    expect(
      decide({ labels: [{ name: "in-progress" }], updatedAt: "2026-09-10T11:00:00Z" }).state,
    ).toBe("STUCK");
  });

  it("is queued while a cockpit run holds it", () => {
    const runs = new Map([[42, { status: "queued", workflow: "implement-ticket" }]]);
    expect(decide({}, { runs }).state).toBe("QUEUED");
  });

  it("sends an issue with an open pull request to review, not to triage", () => {
    const prLinks = new Map([[42, [{ number: 269, title: "t", viaKeyword: true }]]]);
    const seen = decide({ comments: [] }, { prLinks });
    expect(seen.state).toBe("IN_REVIEW");
    expect(seen.warning).toBeNull();
  });

  it("asks about a branch-only link instead of prescribing a closing keyword", () => {
    const prLinks = new Map([[42, [{ number: 268, title: "t", viaKeyword: false }]]]);
    const seen = decide({}, { prLinks });
    expect(seen.state).toBe("IN_REVIEW");
    expect(seen.warning).toContain("Does it close the issue?");
    expect(seen.warning).toContain("if it is a partial fix, nothing to change");
  });

  it("tracks a spec parent instead of asking to triage it", () => {
    expect(decide({ comments: [], body: "Spec: .ai/specs/2026-09-01-x.md\n\n- [ ] #43" }).state).toBe("TRACKING");
  });

  it("waits while an issue it is blocked by is open, and is ready once it closes", () => {
    const body = "## Blocked by\n- #7";
    expect(decide({ body }, { openIssues: new Set([7]) }).state).toBe("WAITING");
    expect(decide({ body }).state).toBe("READY");
  });

  it("holds a not-ready issue until a human answers it", () => {
    const unanswered = [agent(`triage\n\n${BRIEF}`), agent("not ready", "2026-09-03T00:00:00Z")];
    expect(decide({ comments: unanswered }).state).toBe("NOT_READY");
    expect(decide({ comments: [...unanswered, human("ready as is", "2026-09-04T00:00:00Z")] }).state).toBe("READY");
  });

  it("takes a newer readiness-verified verdict as the answer, and an older one as nothing", () => {
    const notReady = [agent(`triage\n\n${BRIEF}`), agent("not ready", "2026-09-03T00:00:00Z")];
    const verified = (at) => agent("`readiness-verifier` — readiness verified", at);
    expect(decide({ comments: [...notReady, verified("2026-09-04T00:00:00Z")] }).state).toBe("READY");
    expect(decide({ comments: [verified("2026-09-02T00:00:00Z"), ...notReady] }).state).toBe("NOT_READY");
  });

  it("does not pick an issue implement-ticket stopped on until someone answers", () => {
    const stop = agent("`implement-ticket` STOP: the brief names no test seam", "2026-09-05T00:00:00Z");
    expect(decide({ comments: [agent(`triage\n\n${BRIEF}`), stop] }).state).toBe("NOT_READY");
    expect(
      decide({ comments: [agent(`triage\n\n${BRIEF}`), stop, human("seam: the trips repo", "2026-09-06T00:00:00Z")] }).state,
    ).toBe("READY");
  });

  it("takes a newer Agent Brief as the answer, since afk-triage settles the gap into one", () => {
    const comments = [agent("not ready", "2026-09-03T00:00:00Z"), agent(`triage\n\n${BRIEF}`, "2026-09-04T00:00:00Z")];
    expect(decide({ comments }).state).toBe("READY");
  });

  it("never makes an issue someone else opened ready, whatever it carries", () => {
    const stranger = { login: "github-actions" };
    const seen = decide({ author: stranger, body: BRIEF });
    expect(seen.state).toBe("EXTERNAL");
    expect(seen.next).toContain("github-actions");
  });

  it("never makes a Sentry ticket ready, even one the maintainer filed", () => {
    const seen = decide({ body: `<!-- sentry-issue: PLANNED-TRAVEL-4KQ -->\n\n${BRIEF}` });
    expect(seen.state).toBe("EXTERNAL");
    expect(seen.next).toContain("sentry-issue");
  });

  it("does not count a brief an untrusted commenter wrote", () => {
    const comments = [human(BRIEF, "2026-09-02T00:00:00Z", { login: "drive-by" })];
    expect(decide({ comments }).state).toBe("NEEDS_TRIAGE");
  });

  it("takes a brief from the body of a ticket the maintainer filed", () => {
    expect(decide({ comments: [], body: `> *This was generated by AI.*\n\n${BRIEF}` }).state).toBe("READY");
  });

  it("does not read a brief heading quoted as code", () => {
    expect(decide({ comments: [], body: "```\n## Agent Brief\n```" }).state).toBe("NEEDS_TRIAGE");
  });

  it("needs triage when the brief or an SDLC label group is missing, and names what", () => {
    expect(decide({ comments: [] }).next).toContain("No Agent Brief yet");
    const seen = decide({ labels: [{ name: "bug" }] });
    expect(seen.state).toBe("NEEDS_TRIAGE");
    expect(seen.next).toContain("No priority label, risk label yet");
  });

  it("calls a briefed, labelled, unclaimed, unblocked issue ready", () => {
    expect(decide().state).toBe("READY");
  });
});

describe("sortIssues", () => {
  it("orders by state, then priority, then number", () => {
    const rows = [
      { number: 2, state: "READY", labels: ["priority-low"] },
      { number: 1, state: "READY", labels: ["priority-high"] },
      { number: 3, state: "BLOCKED", labels: ["priority-low"] },
      { number: 4, state: "READY", labels: [] },
    ];
    expect(sortIssues(rows).map((row) => row.number)).toEqual([3, 1, 4, 2]);
  });
});

describe("countWip", () => {
  const pr = (labels, login = "rafalwolak") => ({
    author: { login },
    labels: labels.map((name) => ({ name })),
  });

  it("counts every open trusted PR, unlabelled drafts included, but not one held with do-not-merge", () => {
    const prs = [
      pr(["review"]),
      pr(["blocked"]),
      pr([]),
      pr(["review"], "dependabot[bot]"),
      pr(["review", "do-not-merge"]),
    ];
    expect(countWip(prs, trusted)).toBe(3);
  });
});

describe("pickNext", () => {
  const rows = sortIssues([
    { number: 5, state: "READY", labels: ["priority-low"] },
    { number: 9, state: "READY", labels: ["priority-high"] },
    { number: 1, state: "NEEDS_TRIAGE", labels: ["priority-extreme"] },
  ]);

  it("takes the highest-priority ready issue, then the oldest", () => {
    expect(pickNext(rows, 0)).toBe(9);
  });

  it("takes nothing at the WIP limit", () => {
    expect(pickNext(rows, WIP_LIMIT - 1)).toBe(9);
    expect(pickNext(rows, WIP_LIMIT)).toBeNull();
  });

  it("takes nothing when nothing is ready", () => {
    expect(pickNext(rows.filter((row) => row.state !== "READY"), 0)).toBeNull();
  });
});

describe("parseArgs", () => {
  it("defaults to text output and a 24-hour threshold", () => {
    expect(parseArgs([])).toEqual({ asJson: false, next: false, staleHours: 24 });
  });

  it("reads --json and --stale-hours in either order", () => {
    expect(parseArgs(["--stale-hours", "6", "--json"])).toEqual({ asJson: true, next: false, staleHours: 6 });
  });

  it("reads --next, and refuses it together with --json", () => {
    expect(parseArgs(["--next"]).next).toBe(true);
    expect(() => parseArgs(["--next", "--json"])).toThrow(/pick one/);
  });

  it("rejects a stray positional instead of taking it as the threshold", () => {
    expect(() => parseArgs(["6"])).toThrow(/unknown argument 6/);
  });

  it.each([[[]], [["abc"]], [["0"]], [["-3"]], [["1.5"]], [["--json"]]])(
    "rejects a malformed --stale-hours value %j",
    (rest) => {
      expect(() => parseArgs(["--stale-hours", ...rest])).toThrow(/--stale-hours/);
    },
  );
});
