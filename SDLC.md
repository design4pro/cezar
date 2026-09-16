# Software delivery process

## Purpose

This file documents how work flows from ticket to merged PR in this repository. The agent skills configured in `.ai/agentic.config.json` enforce the process; humans read it here. PRs target `main`; issues and PRs live in GitHub (via the `gh` CLI), with every tracker operation the skills run defined in `.ai/trackers/github.md` (edit that file to extend or override tracker behavior).

Work enters through two paths: a free-form task brief handed to an agent, or a filed ticket. Both converge on the same review loop, the same validation gate, and the same merge gates.

## Roles

- **Author** — the human or agent who writes the change. Owns the ticket from claim to a merge-ready PR.
- **Reviewer** — reads the diff and approves or requests changes. May be a human or the `om-auto-review-pr` skill; the `om-code-review` checklist applies either way.
- **QA reviewer** — manually exercises user-facing changes before they merge. Always referenced by role, never by name or handle: assignments change.
- **Maintainer** — owns branch protection, the label taxonomy, the config, and this document; arbitrates when gates conflict.

## Ticket lifecycle

| Stage | What happens | Driven by | Done when |
|---|---|---|---|
| Intake | A ticket or task brief is filed in GitHub with enough detail to act on. Agents file tickets too: `afk-to-tickets` slices a merged spec into tracer-bullet tickets, and `afk-architecture-review` files deepening candidates. | Anyone, `afk-to-tickets`, `afk-architecture-review` | Ticket exists |
| Triage | Confirm the issue is real, still unfixed on `main`, and not already claimed or covered by an open PR. Then write an Agent Brief and set exactly one intake label (see Intake labels below). Read-only on code; stops the chain cleanly when there is nothing to do. | `afk-triage`, `om-verify-in-repo`, or a human | One intake label set, or no action needed |
| Claim | The author claims the ticket so concurrent agents back off. See the claim protocol below. | `om-fix` / `om-auto-create-pr`, or a human | Claim visible on the ticket |
| Implement | Locate the minimal change surface (`om-root-cause`, read-only), then implement the change with regression tests and run the validation gate. Task briefs without a ticket go through `om-auto-create-pr`, which plans, implements phase by phase in an isolated worktree, and runs the same gate. | `om-root-cause` + `om-fix`, `om-auto-create-pr`, or a human author | Change complete, validation gate green |
| PR | Commit, push, and open a PR against `main` with normalized labels. On a hand-worked branch, `om-check-and-commit` runs the gate, fixes obvious drift, and pushes when green. | `om-open-pr`, `om-auto-create-pr`, or `om-check-and-commit` | Open, labeled PR |
| Review loop | The reviewer reads the diff against the `om-code-review` checklist and approves or requests changes. Requested changes are addressed (`om-auto-continue-pr` resumes agent PRs from the tracking plan) and the PR is re-reviewed until approved. | `om-auto-review-pr` (single PR), `om-review-prs` (sweep), or a human | Approving review submitted |
| QA | A PR carrying `needs-qa` waits for manual QA. A QA reviewer tests it and records the outcome. See the QA gate below. | QA reviewer (manual) | `qa-approved` applied, or `qa-failed` routes it back |
| Merge | `om-merge-buddy` reports, read-only, which PRs can merge now and which are close but blocked. `om-approve-merge-pr` re-checks every gate, approves, and squash-merges. | `om-merge-buddy` + `om-approve-merge-pr`, or a human | PR squash-merged into `main` |
| Post-merge housekeeping | Close issues the merged PR fixes; comment on issues whose PRs were closed without merging; turn leftover asks or review comments into tracked follow-up issues. | `om-sync-merged-pr-issues`, `om-followup-issue-from-pr` | Tracker reconciled, follow-ups filed |

## Label state machine

Pipeline labels are mutually exclusive: a PR carries at most one, and it names where the PR sits in the flow.

- A ready, non-draft PR carries `review`.
- The reviewer moves it: request changes → `changes-requested`; after fixes it returns to `review`; approval → `merge-queue`.
- `merge-queue` is routing, not proof of QA: a `needs-qa` PR legitimately sits there until QA signs off.
- Only a QA reviewer sets the `qa` pipeline label. They move a queued `needs-qa` PR from `merge-queue` to `qa` while testing, then back to `merge-queue` with `qa-approved` on pass, or to `qa-failed` on failure. Automated skills request QA with `needs-qa`; they never set `qa`.
- `blocked` and `do-not-merge` are set and cleared by humans and stop the flow wherever it is.

| Group | Labels | Exclusivity | Meaning |
|---|---|---|---|
| Pipeline | `review`, `changes-requested`, `qa`, `qa-failed`, `merge-queue`, `blocked`, `do-not-merge` | one at a time | Workflow state |
| Category | `bug`, `feature`, `refactor`, `security`, `dependencies`, `documentation` | additive | Kind of change |
| Meta | `needs-qa`, `skip-qa`, `qa-approved`, `qa-self-verified`, `in-progress` | additive | Process signals |
| Priority | `priority-low`, `priority-medium`, `priority-high`, `priority-extreme` | one at a time; unset = medium | Urgency of the work |
| Risk | `risk-low`, `risk-medium`, `risk-high` | one at a time; unset = medium | Blast radius of the change |

Priority is how urgent the work is; risk is how dangerous the change is to ship. A one-line fix for a broken cockpit can be `priority-extreme` and `risk-low`; a large runner-seam refactor that can wait can be `priority-low` and `risk-high`. A PR inherits both from its source issue unless the scope clearly changed. When an automated skill adds or changes a pipeline or meta label, it leaves a short comment explaining why.

When no priority label is set, infer one:

- `priority-extreme` — the published CLI is broken for users (`npx cezar` fails), data loss in `.ai/cezar/`, or an active security incident.
- `priority-high` — security hardening or a release-blocking regression.
- `priority-medium` — ordinary bug fixes and net-new features (also the default reading of unset).
- `priority-low` — cosmetic, docs-only, dependency bumps, follow-up cleanup.

When no risk label is set, infer one:

- `risk-high` — the runner seam (`packages/cezar/src/core/agent-runner.ts`), worktree/branch handling, the `.ai/cezar/` state file formats, the HTTP API surface, or broad cross-cutting edits.
- `risk-medium` — an ordinary single-area change (also the default reading of unset).
- `risk-low` — docs-only, typo, or isolated cosmetic changes.

When signals conflict, pick the higher label and say why in the label comment. A `risk-high` PR strengthens the case for `needs-qa` and deeper review even when it would otherwise look routine.

One label lives outside this taxonomy: `do-not-close`, applied by humans to issues that housekeeping skills must never auto-close. Skills only ever read it.

## Intake labels

Intake labels go on issues only, one at a time, and say who acts on the issue next. They come before the PR pipeline above. The list lives in `.ai/agentic.config.json` as `labels.intake`.

| Label | Meaning | Set by |
|---|---|---|
| `needs-triage` | Not evaluated yet | Humans; `afk-architecture-review` for its `Strong` candidates |
| `needs-info` | Waiting on the reporter | `afk-triage`, humans |
| `ready-for-agent` | Briefed and safe to implement unattended. Adding it launches the `implement-ticket` automation. | `afk-triage`, `afk-to-tickets` (frontier tickets only), humans |
| `ready-for-human` | Briefed, but needs a person: security, `risk-high`, a spec, a duplicate, a decline, or a judgement call | `afk-triage`, `afk-to-tickets`, `afk-architecture-review`, humans |

- **Transitions:** a new issue, or one labeled `needs-triage`, moves to exactly one of `needs-info`, `ready-for-agent` or `ready-for-human`. When the reporter answers a `needs-info` issue, a human moves it back to `needs-triage`, and triage runs again.
- **Limits on skills:** automated skills never add `ready-for-agent` to `risk-high` or `security` work, never remove an intake label a human set, and never close an issue.
- **Human override:** a human may move any issue to any intake label at any time.

## The QA gate

The one hard rule of this process: **a PR carrying `needs-qa` must not merge until it also carries `qa-approved`, even when every other check is green.** `om-merge-buddy` classifies such a PR as blocked; `om-approve-merge-pr` refuses to merge it.

- Apply `needs-qa` to cockpit UI changes, new features, and other user-facing behavior that needs manual exercise (a `CEZ_DRY_RUN=1` session covers most cockpit flows without a real `claude` login).
- `skip-qa` is the explicit opt-out for docs-only, dependency-only, CI-only, and similarly low-risk non-user-facing changes. Never combine it with `needs-qa`.
- `qa-failed`, `do-not-merge`, and `blocked` are hard blocks regardless of every other signal. An active `qa` pipeline label means a tester is on the PR right now — never merge under an active tester.
- The gate is satisfied when a QA reviewer tests the PR and applies `qa-approved`.
- **Self-QA exception**: when no QA reviewer has capacity in time, any engineer may sign off instead — but only by (1) checking the PR out and running it locally, (2) exercising the affected flow, and (3) attaching evidence to the PR: a screenshot of it working, or a written account of what was exercised and the observed result. Then apply both `qa-approved` (so the gate passes) and `qa-self-verified` (so the exception is auditable). No evidence, no `qa-approved`.

## The claim protocol

Before mutating an issue or PR, an agent claims it with all three signals: it assigns itself, adds the `in-progress` label, and posts a claim comment saying what it is doing. Any agent that finds an existing claim backs off instead of colliding. A PR carrying `in-progress` is also skipped by the merge tooling.

The claim is released when the work finishes — on success and on failure alike. A stale `in-progress` with no recent activity may be cleared by the maintainer.

## Validation gate

Every PR passes the full validation gate before review sign-off, in this order:

- `npm run typecheck`
- `npm test`
- `npm run test:unit`
- `npm run build`
- `npm run test:package`

Any non-zero exit fails the gate and blocks the PR. `npm test` is the fast server + cockpit unit/component suite (vitest) and `npm run test:unit` the node:test core-module suite; the build includes the `check:pack` tarball gate, and `npm run test:package` builds a release tarball, installs it into an isolated consumer, and exercises the offline CLI workflow. User-facing changes also need the separate real-browser QA (`npm run test:e2e`) described by the QA gate. The implementing skills run the configured gate before opening a PR, and `om-check-and-commit` runs it before pushing a hand-worked branch. The command list lives in `.ai/agentic.config.json`; when it changes, update it there and in this section together.

## Scoping rule (SLC)

Every spec, ticket and agent-sized issue is scoped **Simple, Lovable, Complete** (Jason Cohen, "Your customers hate MVPs. Make a SLC instead"), not as a minimum viable product:

- **Simple**: the narrowest scope that does one job. Split anything that does not fit one ticket, or one fresh agent context.
- **Lovable**: no rough edge is left "for later" inside that scope. Error states, empty states, docs and tests ship with the change.
- **Complete**: the slice is useful and verifiable on its own. A change that only works once a later ticket lands is a layer, not a slice: merge it into the slice it serves.

A request that fails the rule is re-scoped (a spec, or tickets), not implemented partially.

## Unattended decisions

The afk-* skills (`.ai/skills/`) run with no human to ask. Where a person would be consulted, the skill picks the most reversible reasonable option and records it as a row in a **Resolved assumptions** table (`# | Question | Applied default | Why`) in the brief, spec or PR body it writes. Humans review those rows at the PR, and overturning one is an ordinary review finding. Domain terms and decisions follow `afk-domain-modeling`: `CONTEXT.md` is updated in the same change, and ADRs are written only when a decision is hard to reverse, surprising, and a real trade-off.

## Repo automations

This repository runs its own intake-to-PR loop on the cockpit. Workflows live in `.ai/cezar/workflows/`, and the automation definitions in `.ai/automations/`.

| Automation | Trigger | Workflow |
|---|---|---|
| `triage.json` | `issue.opened`, or `needs-triage` added | `triage` (`afk-triage`) |
| `implement-ticket.json` | `ready-for-agent` added | `implement-ticket`: read the brief and check blockers and WIP, implement test-first, validation gate (retried twice), `om-open-pr`, `om-auto-review-pr` |
| `spec-to-tickets.json` | weekdays 07:00 | `spec-to-tickets` (`afk-to-tickets`) |
| `architecture-review.json` | Mondays 06:00 | `architecture-review` (`afk-architecture-review`) |
| `lessons.json` | Fridays 16:00 | `lessons` (`afk-lessons`) |

**Bootstrap** on a running cockpit:
1. `cez automation create --file .ai/automations/<name>.json` for each definition. They are created paused.
2. `cez automation check <id>` for polls, or `cez automation run <id>` for schedules.
3. `cez automation enable <id>`.
4. After editing a definition, run `cez automation update <id> --file ...`.

The intake labels must exist first (`gh label create <label>`).

**`maxRecords` is an evaluation budget, not a launch cap.** A poll turns each record into observations — one per opened event, one per reconstructed label event — sorts them oldest-first and evaluates only the first `maxRecords` (`automations/github-poller.ts`). Triage applies four labels within seconds and the decisive one lands last, so `implement-ticket` with `maxRecords: 2` evaluated `documentation` and `priority-low` and never reached `ready-for-agent`: the trigger read as dead. Keep the schema default of 25. Cost is bounded by the WIP limit and the per-skill caps below, never by starving this budget. A truncated poll widens only once a cursor exists, and `cez automation check` never widens at all, so the preview of a starved filter shows a permanent zero.

**A repo-local skill is not invocable by name.** cezar injects a step's skill body as the agent's system prompt (`workflows/run.ts`), but materializes only a *team* skill into `.claude/skills/` (`skills-remote.ts`, gated on `source === 'team'`). An agent that sees an `afk-*` name and calls the `Skill` tool gets `Unknown skill` and must recover on its own - both triage runs opened exactly that way before recovering. So write an `afk-*` skill that never asks to be invoked, and point cross-references at `.ai/skills/<name>/SKILL.md` rather than naming a skill as something to load.

**A cause is not established until an experiment reproduces it.** Three confident causal claims about the same six lines of run output were wrong in one session: "traced to `scripts/mock-claude.mjs`" named the writer but never the caller; `ps eww` cannot read another process's environment on macOS, so an empty grep proved nothing about `CEZ_DRY_RUN`; and the two suites that do set `CEZ_DRY_RUN` turned out to be immune, because a real run's env wins over the host (`core/agent-env.ts`). A five-line probe - point `CEZ_HANDOFF_FILE` at a temp file, run one suite, read the file back - settled it in six seconds and named a different file. State a mechanism as a hypothesis until a controlled run reproduces it, and cite that run.

**Never file an issue carrying the label that triggers its own automation.** Because a poll observes a record once per opened event and once per label event (above), and the durable receipt that prevents a relaunch keys on the automation plus the event rather than on the issue, an issue created with `needs-triage` already attached produces two distinct events in one batch and launches two concurrent triage runs. Issue #4 was created that way and received two Agent Briefs, from runs `7f872da9` and `a82fea56`, 100 seconds apart. File the issue bare and let the `issue.opened` trigger claim it, or add the intake label in a later poll window. The cursor is not the guard here: the scheduler polls from `cursor - 120 s` (`automations/scheduler.ts`), so an already-consumed event stays eligible on later polls and only the receipt stops the second launch.

**Pausing an automation and enabling it again silently drops everything that arrived in between.** `enable` sets `baselineAt` to the current time and moves the cursor with it, and the scheduler discards every candidate at or below the baseline (`automations/scheduler.ts`), so the gap is skipped permanently rather than caught by the next poll. That is deliberate on a first enable - a backlog is never launched - and a trap for an operator who pauses to investigate something. Check that the pause window was empty before enabling again, and to act on an item that is already pending use `cez automation check <id> --execute`, which launches it without touching the baseline.

**An automation resolves its workflow from the working tree, so switching branches disables every automation.** The workflow YAMLs (`.ai/cezar/workflows/`) and the committed definitions (`.ai/automations/`) exist only on `feat/afk-engineering-standards`; the integration branch carries neither. Checking out a branch off it therefore emptied the workflow directory, and the next poll logged `unknown workflow: triage` (`automation-log.ndjson` seq 49, 09:23:47Z) after a clean `no-match` at 09:13:44Z. Switching back does not undo it: `recordFailure` (`automations/scheduler.ts`) backs off `60 s x 2^(failures-1)` capped at six hours, so eight consecutive failures moved the next check out to 12:07:53Z - more than two hours after the files returned. Until those files live on the base branch, treat any branch switch in the main checkout as pausing every automation, and check the log after one.

**A failed launch still consumes the event: the receipt is reserved before the run starts and never released.** `launch()` (`automations/scheduler.ts`) calls `reserveReceipt` first and returns early with `duplicate` when one already exists; when the launch throws it appends that same receipt with `status: 'launch-error'` and rethrows, and nothing ever removes the reservation. An event that failed for a transient reason is therefore suppressed permanently - every later poll reports `duplicate`, so the issue is never triaged and no run is ever created. Issues #6, #7 and #8 were consumed exactly this way while the workflow directory was missing: their `issue.opened` receipts exist (event timestamps 09:23:06Z, 09:23:29Z and 09:50:08Z) and no triage run exists for any of them. Recovery is manual - delete the matching lines from `.ai/cezar/automation-receipts.ndjson`, which is runtime state, and re-check.

**Read an automation's next poll time from its state file; never compute it.** Any operation that rewrites the working tree - a rebase, a checkout, a stash - briefly empties `.ai/cezar/workflows/` and so must run between polls (above). Deriving that window by hand is how it goes wrong: a twelve-commit rebase was guarded by a hardcoded 10:53:42Z and reported 601 s of headroom while the automation's `nextRunAt` was 10:43:42.378Z, two seconds away. It survived on luck alone - the replay finished before the poll read the directory at 10:43:55.742Z, leaving `consecutiveFailures: 0`. The authoritative value is `nextCheckAt` for that automation in `.ai/cezar/automation-state.json`, which the scheduler rewrites on every poll. Read it, and abort when the margin is thin instead of trusting your own arithmetic over the system's recorded state.

**Guardrails:**
- Nothing merges automatically: no workflow uses `om-approve-merge-pr`.
- `implement-ticket` stops when three or more agent PRs already wait in `review`.
- Triage never sends `risk-high` or `security` work to an agent.
- Every skill carries hard caps: one issue per triage, eight tickets per spec, three architecture issues, one lessons PR.
- To stop it all, `cez automation pause <id>`, or start the cockpit with `CEZ_AUTOMATIONS=0`.

## Amending this process

This document and `.ai/agentic.config.json` describe the same process: change them together, and re-run the `om-setup-agent-pipeline` skill when the toolchain or label taxonomy changes. Per-skill deviations — extra review rules, a different PR body template, an added gate step — belong in a repo-local skill of the same name at `.ai/skills/<skill-name>/SKILL.md`, which takes precedence over the installed skill (and can `@`-import or reference it to extend rather than replace it); local rules win, but a repo-local skill cannot grant what the installed skill's safety rules forbid.
