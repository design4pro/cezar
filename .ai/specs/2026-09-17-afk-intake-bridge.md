# The AFK intake bridge

> Status: draft
> Scope: `cezar`, `planned.travel`, `money-tracker.online` — the three repositories that share
> `design4pro/agent-kit` (kitVersion 42) and the `SDLC.md` skeleton converged on 2026-09-17.
> Phase 1 (documentation and config) is applied. Phase 2 is designed and **not** applied.

## TLDR

Two intake ladders exist in the product repositories and only one of them is connected. The
`om-*` ladder works and is driven entirely by a human adding `autofix`. The `afk-*` ladder —
`needs-triage` → `afk-triage` → `ready-for-agent` → `implement-ticket` — is fully wired,
enabled, and has launched **zero** runs in eleven days, because **nothing applies the first
label**. `om-auto-manage-issues` computes a `READY_STATUS` and stops; no skill and no automation
turns that verdict into `needs-triage`.

The fix is one edge, called the **bridge**: a groom that ends `READY_STATUS=ready` applies
`needs-triage` as its last mutation. Everything downstream of it already exists and is already
bounded. This spec records the evidence, the sequencing, and the assumptions taken without asking.

## Evidence

Measured 2026-09-17, from `.ai/cezar/runs.json`, `.ai/cezar/automation-log.ndjson` and `gh`:

| | `planned.travel` | `money-tracker.online` | `cezar` |
| --- | --- | --- | --- |
| Open issues | 85 | 35 | — |
| `ready-for-agent` | **0** | **0** | — |
| `needs-triage` | **0** | **0** | — |
| `issue-groom` runs | 113 | 41 | 0 |
| `issue-autofix` runs | 87 | 67 | 0 |
| `pr-autopilot` runs | 23 | 49 | 0 |
| `triage` runs | 3 | 2 | 11 |
| `implement-ticket` runs | **0** | **0** | 3 |
| "Implement ready-for-agent issues" polls | ~200 | ~80 | — |
| …of which launched | **0** | **0** | — |

Three readings follow from that table:

1. **The gap is at intake, not at review.** PR cycle time is healthy in both product
   repositories: median ≈ 1 h, p90 ≈ 10 h. Throughput is capped by a human adding roughly eleven
   `autofix` labels a day. Backlog grew +87 and +35 over 30 days.
2. **The `afk-*` ladder is not broken, it is unreachable.** Its automations are enabled, their
   filters are correct, and `cezar` — where a human does add `needs-triage` — ran triage 11 times
   and `implement-ticket` 3 times off the same definitions.
3. **The missing edge is a single omission, not a design flaw.** `grep -c 'ready-for-agent'` in
   `om-auto-manage-issues/SKILL.md` returns 0 in both repositories. `needs-triage` is applied by
   nothing except `afk-architecture-review`'s weekly `Strong` candidates.

## Why bridge rather than retire one ladder

`autofix` and `needs-triage` answer different questions. `autofix` is a human saying *do this one
now*; `needs-triage` is the pipeline saying *this is ready, decide who takes it*. Retiring either
loses a capability. Two properties make running both safe:

- **The bridge is event-driven.** It fires inside a groom, and a groom fires on `issue.opened` or
  the `groom` label. The 120 open issues generate no new event, so turning the bridge on does not
  flood the pipeline with the backlog. Catching those up is a separate, deliberate act.
- **The cap is shared and it is on inventory.** `implement-ticket` stops when three agent PRs
  already wait in `review`, and `issue-autofix` output counts against that same cap, because both
  ladders publish under one `gh` identity. The brake is on unreviewed inventory, not on generation
  rate, so a burst of intake cannot outrun review capacity.

## Phase 1 — applied 2026-09-17

1. **One `SDLC.md` skeleton across the three repositories.** Sections 1 to 17 byte-identical;
   `## This repository` is the only per-repo section, fenced by `<!-- BEGIN per-repo -->` and
   `<!-- END per-repo -->`. The base branch, the merge mechanics, the QA routing and the automation
   table are named once each, there. Verification: `diff` of the truncated files is empty for all
   three pairs.
2. **Four contradictions removed.** `money-tracker.online`'s "No intake label starts a run" was
   false in its own repository (its enabled automation launches `implement-ticket` on
   `ready-for-agent`); ADR 0017 gained an amendment answering the question it had deferred to "the
   first retro". `cezar`'s "PRs target `main`" became `design4pro`. The SLC scoping rule, cited by
   `afk-triage` and `afk-to-tickets` in all three repositories and defined only in `cezar`, is now
   in the shared skeleton. `planned.travel`'s `docs/agents/triage-labels.md` gained the intake
   group, in its table and in its flow diagram.
3. **The validation gate is stated once.** `validation.commands` in `.ai/agentic.config.json` is
   the only list of record. `money-tracker.online/AGENTS.md` had lost the gate's *first* command —
   `node .ai/scripts/agent-kit-check.mjs` — so an agent that followed it failed CI on a file it had
   never edited; `CONTRIBUTING.md` called a three-command fast loop "the gate".
4. **`labels.*` completed.** A `command` group (`groom`, `autofix`, `spec`, `review-threads` — four
   labels that four live automations read and no config knew) and an `outside` group. `cezar` also
   gained `baseBranch: "design4pro"`, `reviewChecklist: "CODE_REVIEW.md"` and `ci-monitoring`.
5. **The `afk-*` layer is visible where agents start**: `planned.travel/CLAUDE.md` and
   `money-tracker.online/AGENTS.md`.

## Phase 2 — designed, sequenced, not applied

Strictly ordered. Each step names its file and its verification.

### P1 — `implement-ticket` has no bootstrap step

In both product repositories the workflow starts at `- id: implement`. The only `pnpm install`
lives in the **gate** step, which runs *after* the agent. So the step told to "write the failing
test, see it fail" would run with no `node_modules`, no `src/routeTree.gen.ts`, no local D1 and no
secrets. This has never been observed because the workflow has launched zero times — and it is why
P1 must land before the bridge, or the bridge feeds a broken executor.

`issue-autofix.yml` already has the step, and `agent-kit/vars/*.json` already carry
`bootstrapFullName` and `bootstrapFullCommand`. Edit
`agent-kit/templates/.ai/cezar/workflows/implement-ticket.yml`, sync, and commit the regenerated
workflow **and** the lock.

*Verify:* `node .ai/scripts/agent-kit-check.mjs` exits 0, and the diff is exactly one added step.

### P2 — Prove the loop by hand, once, on `money-tracker.online`

Smaller blast radius than `planned.travel`: 102 issues in 30 days against 208, and its 35 open
issues are already groomed. Add `needs-triage` by hand to one `risk-low`, non-`security` issue.

*Verify, in this order, reading `runs.json` `steps[].status` and never a banner:* a `triage` run
exists → an `## Agent Brief` comment is on the issue → exactly one intake label → the **first
non-zero `launched`** for "Implement ready-for-agent issues" in ~80 polls → the gate step with
`iterations` ≤ 2 → a PR carrying `review` → **nothing merged**.

Do not proceed to P3 until this passes.

### P3 — The bridge itself

One bullet in `money-tracker.online/.ai/skills/om-auto-manage-issues/SKILL.md` (repo-owned, 12
lines, not kit-hashed): when `READY_STATUS=ready` and the issue carries no `labels.intake` label,
apply `needs-triage` **as the last mutation of the run**. Never on `not-ready`. Never on an issue
carrying `blocked`, `do-not-close` or `do-not-merge`. Then the identical bullet in
`planned.travel`'s copy, one week later.

Do **not** lower `maxRecords: 25` on the triage automation. `cezar`'s own lesson is that the
decisive label lands last in a poll batch, and a starved budget reads as a dead trigger.

*Verify:* a throwaway ready issue produces a `launched`; a deliberately thin one gets the not-ready
comment and **no** `needs-triage`.

*Watch for 7 days:* if open `review` PRs pin at the cap of 3, the bottleneck moved rather than
closed. Revert by deleting the bullet.

### P4 — Give every state an exit

`SDLC.md` § Unattended decisions states the rule this step enforces: a state whose only
on-by-default exit is "a human types something" is a dead end.

| State | Today | Proposed |
| --- | --- | --- |
| `changes-requested` on a bot PR | Dead. `om-auto-continue-pr` exists; no automation calls it, and `implement-ticket`'s review step is its last | An `om-auto-continue-pr` pass in the `housekeeping` workflow, agent-authored PRs idle > 2 h, cap 2 per pass. **Highest leverage; must land with `planned.travel`'s bridge** |
| `needs-info` | Dead — "a human moves it back" | Reuse the `answered` predicate already in `backlog-status.mjs`; swap to `needs-triage`. TTL: comment at 14 d, close at 21 unless `do-not-close` |
| `blocked` | Dead, and populated: 11 issues, 17–18 days old | See P5 |
| `qa-failed` | Dead on a bot PR | Route to `pr-fix`, then back to `review` + `needs-qa`. **Needs the maintainer's explicit yes** — pipeline exclusivity means a skill would clear a label a QA reviewer set |
| `merge-queue` | Correctly human, but a conflicted one is silent | Report-only: `om-merge-buddy` comments once past 48 h naming what blocks it |
| `ready-for-human` | Correctly human, but unbounded and uncounted — and it is the queue the bridge grows fastest | First-class state in `backlog-status.mjs` with an age distribution |

A prerequisite the audit surfaced: in **both** product repositories, `housekeeping`, `backlog`,
`brainstorm`, `implement-spec` and `pr-review` are workflows with **no automation at all**. They are
started by hand. So `om-close-fixed-issues` and `om-review-prs` never run unattended today, and an
issue whose PR merged stays open until someone runs them. `planned.travel`'s
`docs/agents/triage-labels.md` claimed a weekday 07:00/12:00/17:00 schedule for `housekeeping` that
does not exist; Phase 1 corrected the claim. P4's first row presumes that automation exists, so
scheduling `housekeeping` is its real first step.

### P5 — Unblock the stage tickets

The 11 `blocked` issues are not blocked; they are unsequenced. `gh api .../issues/104/sub_issues`
shows #120–#125 carrying only `blocked`, with no `## Blocked by` section: the order is encoded in
the stage id (`01-S7`, `01-S8a`…) of a `docs/plans/` file. `afk-to-tickets` only recognises a parent
whose body starts with `Spec: .ai/specs/` — measured: **0** such issues in either repository, while
11 and 4 use `Parent PRD: #n` with `docs/plans/`.

Three changes in `agent-kit/templates/.ai/skills/afk-to-tickets/SKILL.md`: resolve parents bottom-up
from `Parent PRD: #\d+` **or** `Spec: \S+\.md`; derive the blocking edge from the previous open
stage id; and promote the frontier to **`needs-triage`, not `ready-for-agent`** — every one of those
tickets is `Scope: L` and must face the SLC gate.

Remove `blocked` **only** from a body carrying all three of `<!-- schema: ticket/v2 -->`,
`Parent PRD: #n` and `Stage … of docs/plans/` — a conjunction that matches the 8 stage tickets and
none of the 3 genuine human holds (#466, #444, #407). The first run must be human-started and its
diff read before the 07:00 schedule fires.

### P6 — cezar's own gaps

- **No CI on the working branch.** `.github/workflows/ci.yml` triggers on `main` and `develop`;
  `design4pro` is the base branch and is 51 commits ahead of `main`. Add `design4pro` to
  `pull_request.branches` and `push.branches`, land it **non-required first**, read it, fix, then
  require.
- **No merge gate.** Adopt `merge-gate.yml` + `scripts/ci/merge-gate.mjs` by adding them to cezar's
  entry in the kit manifest's `only` list.
- **Automation drift.** The runtime `.ai/cezar/automations.json` has already lost `worktree: true`
  on 4 of 5 definitions and the `dispatch` block. Re-apply from `.ai/automations/*.json` **before**
  any sync in the other direction, or the drift becomes canonical.

### P7 — Observability with zero new configuration

Everything the measurement above needed was already on disk. Add `--flow` to
`agent-kit/templates/.ai/scripts/backlog-status.mjs` — already read-only, already tested, already
invoked by `backlog.yml`: launches-vs-polls per automation from `automation-log.ndjson` (the
signature that found this bug), intake latency, time-to-first-PR (its `linkOpenPrs()` already solves
the non-default-branch linkage), review turnaround, gate-retry rate from `runs.json`
`steps[id=gate].iterations`, STOP rate, and token coverage reported as "N of M runs" — because
cezar has already measured that a substring match on `total_cost` lies. `afk-lessons` reads it on
Friday, so the weekly lesson becomes measured rather than anecdotal.

## Too risky to do unattended

1. Enabling the bridge on `planned.travel` before `money-tracker.online` has run a week — 208
   issues per 30 days, and `implement-ticket` has never provisioned that repository's D1, secrets
   or basemap.
2. P5's `blocked` removal: a skill deleting a label a human may have set is what `SDLC.md` forbids.
   The marker conjunction is exact on today's data; the first run is still human-started.
3. The `qa-failed` exit: a deliberate weakening of a human QA signal.
4. Making cezar's merge gate a required check before CI has run once.
5. Any direct edit to a file listed in `.ai/agent-kit.lock.json` — it fails the first command of the
   validation gate, so it fails every PR in that repository.
6. Bulk-applying `needs-triage` to the existing 120 open issues to "catch up". The bridge is safe
   precisely because it is event-driven and flow-rate limited.

## Resolved assumptions

| # | Question | Applied default | Why |
| --- | --- | --- | --- |
| 1 | Reconcile the two ladders by retiring one, or by connecting them? | Connect: `om-auto-manage-issues` ends a ready groom with `needs-triage`. Nothing is retired. | Each answers a different question, and the express lane is the only working path today. Deleting either loses a capability; the edge costs one bullet in one repo-owned skill. |
| 2 | Which repository goes first? | `money-tracker.online` | Half the issue rate, and its open issues are already groomed, so the first launches are predictable. |
| 3 | Should the bridge back-fill the existing 120 open issues? | No. Event-driven only. | A backlog flood is the one failure mode the WIP cap cannot absorb gracefully, and a first enable deliberately never launches a backlog. |
| 4 | Does the shared `SDLC.md` skeleton name the base branch inline, as the upstream `om-setup-agent-pipeline` template renders it? | No — once, in `## This repository`. | Byte-identity across three repositories is what makes drift detectable by `diff`. Recorded in § Amending this process so a template re-run does not silently undo it. |
| 5 | `cezar` has no trigger labels. Omit `labels.command`, or write an empty array? | Empty array. | "None wired here" is a fact worth asserting; an absent key is indistinguishable from an unconfigured one. |
| 6 | `needs-e2e` in the shared Outside group? | No — `planned.travel` only. | It was deleted from `money-tracker.online` by ADR 0017 and never existed in `cezar`. A shared section must be true in all three. |
| 7 | Strip the annotated command list from `cezar/AGENTS.md` for a bare pointer? | No — keep the annotations, subordinate them explicitly to the config. | The annotations explain what each command does, which the config cannot. The failure mode being fixed is a *contradicting* second list; `cezar`'s matched the config, and the section now says the config wins. |
| 8 | Document the bridge in the present tense, since it is the agreed design? | No — future tense, with a pointer here. | It is not wired. A process document that describes an edge that does not exist is the same defect this spec was written to fix. |
