# Software delivery process

## Purpose

This file documents how work flows from ticket to merged PR in this repository. The agent skills configured in `.ai/agentic.config.json` enforce the process; humans read it here. Issues and PRs live in GitHub, with every tracker operation the skills run defined in `.ai/trackers/github.md` (edit that file to extend or override tracker behavior).

Everything above the `BEGIN per-repo` marker near the end of this file is shared, word for word, with the sibling repositories that run this pipeline; `## This repository`, below that marker, is the only section that differs. So this document never names the base branch, the merge mechanics, or the automations by hand: **the base branch is `.ai/agentic.config.json` → `baseBranch`, and it is named once, in `## This repository`.** Everything below that says "the base branch" means that value.

Work enters through two paths: a free-form task brief handed to an agent, or a filed ticket. Both converge on the same review loop, the same validation gate, and the same merge gates.

Before intake, the work is shaped: `om-discover` establishes the product context every later decision reads (`.ai/specs/product-brief.md` — who the users are, what hurts, what the product is not, which rules and decisions bind the work), `om-brainstorm` turns a single idea or question into a routing decision and a brief, and the spec skills (`om-spec-writing`, `om-auto-write-spec`) turn a feature into a design document before anything is built. Those steps feed the table below; they are not the ticket flow itself, and the Definition of Ready is the contract between them and Intake.

## Roles

- **Author** — the human or agent who writes the change. Owns the ticket from claim to a merge-ready PR.
- **Reviewer** — reads the diff and approves or requests changes. May be a human or the `om-auto-review-pr` skill; the `om-code-review` checklist applies either way.
- **QA reviewer** — manually exercises user-facing changes before they merge. Always referenced by role, never by name or handle: assignments change.
- **Maintainer** — owns branch protection, the label taxonomy, the config, and this document; arbitrates when gates conflict.

## Ticket lifecycle

| Stage                   | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                 | Driven by                                                                                        | Done when                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Discovery               | The product context is established before any idea is weighed — problem and who has it, stakeholders, rules, flows, success criteria, scope — from material that exists, with every claim tagged by its evidence and every decision owned by a person. Then an idea, question, or itch is talked through: the problem is questioned, alternatives (including building nothing) are weighed, and the conversation ends in a routing decision. | `om-discover` (product level) and `om-brainstorm` (one idea), or a human                         | A product brief, or a routed conversation with a brief when the work continues |
| Intake                  | A ticket or task brief is filed in GitHub and meets the Definition of Ready below. `om-prepare-issue` files it with SDLC labels and the ready sections; `om-auto-manage-issues` grooms what is already filed and reports what it still lacks. Agents file tickets too: `afk-to-tickets` slices a merged spec into tracer-bullet tickets, and `afk-architecture-review` files deepening candidates.                                           | Anyone, `om-prepare-issue`, `om-auto-manage-issues`, `afk-to-tickets`, `afk-architecture-review` | Ticket exists and is ready, or its gaps are named on the ticket                |
| Triage                  | Confirm the issue is real, still unfixed on the base branch, and not already claimed or covered by an open PR. Then write an Agent Brief, or put a `blocked` hold on it naming what a person must do (see Readiness below). Read-only on code; stops the chain cleanly when there is nothing to do.                                                                                                                                          | `afk-triage`, `om-verify-in-repo`, or a human                                                    | An Agent Brief posted or a hold set, or stopped as no-action                   |
| Claim                   | The author claims the ticket so concurrent agents back off. See the claim protocol below.                                                                                                                                                                                                                                                                                                                                                    | `om-fix` / `om-auto-create-pr`, or a human                                                       | Claim visible on the ticket                                                    |
| Implement               | Locate the minimal change surface (`om-root-cause`, read-only), then implement the change with regression tests and run the validation gate. Task briefs without a ticket go through `om-auto-create-pr`, which plans, implements phase by phase in an isolated worktree, and runs the same gate.                                                                                                                                            | `om-root-cause` + `om-fix`, `om-auto-create-pr`, or a human author                               | Change complete, validation gate green                                         |
| PR                      | Commit, push, and open a PR against the base branch with normalized labels. On a hand-worked branch, `om-check-and-commit` runs the gate, fixes obvious drift, and pushes when green.                                                                                                                                                                                                                                                        | `om-open-pr`, `om-auto-create-pr`, or `om-check-and-commit`                                      | Open, labeled PR                                                               |
| Review loop             | The reviewer reads the diff against the `om-code-review` checklist and approves or requests changes. Requested changes are addressed (`om-auto-continue-pr` resumes agent PRs from the tracking plan, and adopts a PR that has none by reconstructing the plan from the PR's own context) and the PR is re-reviewed until approved.                                                                                                          | `om-auto-review-pr` (single PR), `om-review-prs` (sweep), or a human                             | Approving review submitted                                                     |
| QA                      | A PR carrying `needs-qa` waits for manual QA. A QA reviewer tests it and records the outcome. See the QA gate below.                                                                                                                                                                                                                                                                                                                         | QA reviewer (manual)                                                                             | `qa-approved` applied, or `qa-failed` routes it back                           |
| Merge                   | `om-merge-buddy` reports, read-only, which PRs can merge now and which are close but blocked. `om-approve-merge-pr` re-checks every gate, approves, and merges by whatever mechanism `## This repository` names.                                                                                                                                                                                                                             | `om-merge-buddy` + `om-approve-merge-pr`, or a human                                             | PR merged into the base branch                                                 |
| Post-merge housekeeping | Close issues the merged PR fixes; comment on issues whose PRs were closed without merging; turn leftover asks or review comments into tracked follow-up issues.                                                                                                                                                                                                                                                                              | `om-close-fixed-issues`, `om-followup-issue-from-pr`                                             | Tracker reconciled, follow-ups filed                                           |

## Definition of Ready

A ticket is ready for implementation when the answers below are on the ticket or in a spec it links. They come in two tiers, because a spec can supply the second but never the first.

**Ticket-level — only a human can supply these:**

- the problem or need, and who has it (a user or a role);
- the expected outcome, and how it will be checked;
- what is out of scope;
- open questions, each marked blocking or non-blocking — no blocking question left unanswered;
- any autonomous assumption confirmed by a human (the resolved-assumptions comment on a spec PR).

**Spec-level — a covering spec supplies these, and `om-auto-write-spec` writes them when they are missing:**

- acceptance criteria;
- business rules;
- the happy path and the main unhappy paths;
- impact on data and permissions;
- dependencies;
- a link to the prototype or mockups when the change is user-facing.

For a bug, ready means reproducible: `om-verify-in-repo` is that gate, and the list above applies only to its ticket-level items. Enforcement: `om-prepare-issue` files tickets with these sections; `om-auto-manage-issues` records `READY_STATUS` per issue and posts a not-ready comment naming what is missing; `om-auto-fix-issue`'s feature route stops on a ticket that fails the ticket-level tier instead of speccing around the gap, the way `om-verify-in-repo` stops on a bug that is not real. Spec-level gaps are not a stop — the spec is authored. A maintainer may waive an item by saying so on the ticket.

**The Definition of Ready is the gate an unattended pipeline is built on.** `READY_STATUS` is the one machine-readable verdict that says a ticket can be worked without asking a person a question, so every automatic hand-off from grooming to triage reads it and nothing downstream re-derives it. A ticket that is not ready is commented on and left alone; it is never handed to an implementing agent on the theory that the agent will work the gap out.

## Product decisions as a protected contract

When `om-discover` has written `.ai/specs/product-brief.md`, its **Non-goals**, **Business rules**, and **Decisions** tables are protected the way `BACKWARD_COMPATIBILITY.md` protects contract surfaces. Each entry carries a stable id (`N01`, `R03`, `D07`), an owner, a status (`active` or `superseded`), a review-by date, and a required path for changing it. The rules:

- A PR that builds something a non-goal excludes, or contradicts a business rule or a decision, without a superseding entry in the same PR is a **blocker** in review, quoting the entry and its id. The way out is never "delete the code": it is "change the decision explicitly" — a superseding row approved by the entry's owner, with the maintainer arbitrating a dispute, as in Roles.
- The decisions in play are surfaced where people work, not remembered: `om-auto-manage-issues` lists them in its implementation-notes comment, `om-spec-writing` carries a _Decisions in play_ section, and every PR body carries _Decisions touched_. A newcomer or a new agent reads them at the issue, the spec, or the PR, not in a chat history.
- An autonomous assumption a human confirmed on a spec PR (the resolved-assumptions comment) is recorded as a decision on the next `om-discover --refresh`, with the confirmer as owner, so the reason a thing is the way it is survives the people who decided it.
- Decisions age: an entry past its review-by date is flagged in review as due for a look, not enforced blindly. Which entries block more than they protect is a retro question.

## Scoping rule (SLC)

Every spec, ticket and agent-sized issue is scoped **Simple, Lovable, Complete** (Jason Cohen, "Your customers hate MVPs. Make a SLC instead"), not as a minimum viable product:

- **Simple**: the narrowest scope that does one job. Split anything that does not fit one ticket, or one fresh agent context.
- **Lovable**: no rough edge is left "for later" inside that scope. Error states, empty states, docs and tests ship with the change.
- **Complete**: the slice is useful and verifiable on its own. A change that only works once a later ticket lands is a layer, not a slice: merge it into the slice it serves.

A request that fails the rule is re-scoped (a spec, or tickets), not implemented partially. `afk-triage` and `afk-to-tickets` both gate on this rule: a ticket too large for one fresh agent context never gets an Agent Brief as it stands. The skill splits it, on a product owner specialist's verdict (§ Delegated decisions), into a first slice it briefs and follow-up issues it files.

## Label state machine

Pipeline labels are mutually exclusive: a PR carries at most one, and it names where the PR sits in the flow.

- A ready, non-draft PR carries `review`.
- The reviewer moves it: request changes → `changes-requested`; after fixes it returns to `review`; approval → `merge-queue`.
- `merge-queue` is routing, not proof of QA: a `needs-qa` PR legitimately sits there until QA signs off. The label is this state machine's and is not GitHub's merge queue: a PR carrying it is waiting for the merge step `## This repository` describes, and only that step puts it in whatever queue GitHub runs.
- Only a QA reviewer sets the `qa` pipeline label. They move a queued `needs-qa` PR from `merge-queue` to `qa` while testing, then back to `merge-queue` with `qa-approved` on pass, or to `qa-failed` on failure. Automated skills request QA with `needs-qa`; they never set `qa`.
- `blocked` and `do-not-merge` stop the flow wherever it is. A skill may set `blocked` on an issue with a 🤖 comment naming what a person must do; only a person clears either.

| Group    | Labels                                                                                     | Exclusivity                   | Meaning                            |
| -------- | ------------------------------------------------------------------------------------------ | ----------------------------- | ---------------------------------- |
| Pipeline | `review`, `changes-requested`, `qa`, `qa-failed`, `merge-queue`, `blocked`, `do-not-merge` | one at a time                 | Workflow state                     |
| Category | `bug`, `feature`, `refactor`, `security`, `dependencies`, `documentation`                  | additive                      | Kind of change                     |
| Meta     | `needs-qa`, `skip-qa`, `qa-approved`, `qa-self-verified`, `in-progress`, `ci-monitoring`   | additive                      | Process signals                    |
| Priority | `priority-low`, `priority-medium`, `priority-high`, `priority-extreme`                     | one at a time; unset = medium | Urgency of the work                |
| Risk     | `risk-low`, `risk-medium`, `risk-high`                                                     | one at a time; unset = medium | Blast radius of the change         |
| Outside  | `do-not-close`                                                                             | additive                      | A human hold no skill may override |

An issue carries the category, priority and risk groups and the holds, and nothing else: no label says an issue is ready or starts a run (§ Readiness). `do-not-close` is the one label outside the Open Mercato taxonomy, and no other is created. Every group is also `labels.*` in `.ai/agentic.config.json`, and that file is what the skills read — a label this document names and the config does not is a label no skill will apply.

Priority is how urgent the work is; risk is how dangerous the change is to ship. A one-line fix for an outage can be `priority-extreme` and `risk-low`; a large auth refactor that can wait can be `priority-low` and `risk-high`. A PR inherits both from its source issue unless the scope clearly changed. When an automated skill adds or changes a pipeline or meta label, it leaves a short comment explaining why.

When no priority label is set, infer one:

- `priority-extreme` — production outage, data loss, or an active security incident.
- `priority-high` — security hardening or a release-blocking regression.
- `priority-medium` — ordinary bug fixes and net-new features (also the default reading of unset).
- `priority-low` — cosmetic, docs-only, dependency bumps, follow-up cleanup.

When no risk label is set, infer one:

- `risk-high` — auth, sessions, data scoping, money, schema migrations, shared contract surfaces, or broad cross-cutting edits. `## This repository` names the surfaces that are `risk-high` here.
- `risk-medium` — an ordinary single-area change that ships with tests (also the default reading of unset).
- `risk-low` — docs-only, test-only, typo, or isolated cosmetic changes.

When signals conflict, pick the higher label and say why in the label comment. A `risk-high` PR strengthens the case for `needs-qa` and deeper review even when it would otherwise look routine, and it sends the issue past a security and tenancy specialist (§ Delegated decisions) before any unattended implementing skill may take it.

## Readiness

No label says an issue is ready, and no label starts a run. The taxonomy above is the whole vocabulary; readiness is computed.

An issue is **ready** when all of these hold: it is open; a maintainer opened it (the `authors` gate of the issue automations) and it was not filed from production error data (a `sentry-issue` marker); its body or a maintainer's comment carries an `## Agent Brief`; it has a category, a priority and a risk label; every issue under its `Blocked by` is closed; no open PR addresses it; no 🤖 not-ready or `STOP:` comment waits for an answer; and it carries none of `blocked`, `do-not-merge`, `do-not-close` or `in-progress`. `.ai/scripts/backlog-status.mjs` is the one implementation of that rule. It prints the report a person reads, and with `--next` it picks the issue the scheduled `implement-ticket` run takes: highest priority first, then oldest, and nothing while three agent PRs are open - every open PR a maintainer authored except one carrying `do-not-merge`, drafts and blocked ones included, so a stalled PR cannot slip past the cap.

- **How an issue gets there.** Opening it starts triage: `afk-triage` writes the Agent Brief, or puts a `blocked` hold on it with a comment naming the one thing a person must do. `afk-to-tickets` files tickets whose body is their brief.
- **How it leaves a hold.** A person removes `blocked`, and that event triages the issue again.
- **Limits on skills:** an implementing run takes `risk-high` or `security` work only on a security and tenancy specialist's approving verdict, recorded with its conditions as acceptance criteria. Skills never close an issue and never remove a hold a person set.
- **Human override:** a person starts any workflow on any issue from the cockpit at any time.

## The QA gate

The one hard rule of this process: **a PR carrying `needs-qa` must not merge until it also carries `qa-approved`, even when every other check is green.** `om-merge-buddy` classifies such a PR as blocked; `om-approve-merge-pr` refuses to merge it.

- Apply `needs-qa` to UI changes, new features, and other user-facing behavior that needs manual exercise. Which paths make a PR `needs-qa` here is in `## This repository`.
- `skip-qa` is the explicit opt-out for docs-only, dependency-only, CI-only, test-only, and similarly low-risk non-user-facing changes. Never combine it with `needs-qa`.
- `qa-failed`, `do-not-merge`, and `blocked` are hard blocks regardless of every other signal. An active `qa` pipeline label means a tester is on the PR right now — never merge under an active tester.
- The gate is satisfied when a QA reviewer tests the PR and applies `qa-approved`.
- **Self-QA exception**: when no QA reviewer has capacity in time, any engineer may sign off instead — but only by (1) checking the PR out and running it locally, (2) exercising the affected flow, and (3) attaching evidence to the PR: a screenshot of it working, or a written account of what was exercised and the observed result. Then apply both `qa-approved` (so the gate passes) and `qa-self-verified` (so the exception is auditable). No evidence, no `qa-approved`.

## The claim protocol

Before mutating an issue or PR, an agent claims it with all three signals: it assigns itself, adds the `in-progress` label, and posts a claim comment saying what it is doing. Any agent that finds an existing claim backs off instead of colliding. A PR carrying `in-progress` is also skipped by the merge tooling.

`in-progress` means **actively working**. Once an agent's work is finished and fully reported — labels applied, review submitted, comments posted — it swaps `in-progress` for `ci-monitoring` if it still intends to report the CI outcome. `ci-monitoring` is **not** a claim and blocks nobody: it says only that the CI-result follow-up comment is still owed, so another agent or a human may act on the PR freely. That distinction matters because CI runs long: an agent that reported its work and then died while watching a run leaves an honest, self-describing state instead of a lock nobody holds. The label comes off when the follow-up lands, or when the agent gives up waiting at `ci.maxWaitMinutes` and says so.

The claim is released when the work finishes — on success and on failure alike. A stale `in-progress` with no recent activity may be cleared by the maintainer.

### Reporting is decoupled from CI

Agents apply labels, submit reviews, and post comments **as soon as their work is done**, without waiting for CI to go green. A review submitted while checks are still running says so in its body: branch protection plus the QA-approval gate hold the actual merge, and the approval covers the code, not a green run. The CI outcome arrives afterwards as a follow-up comment, which also corrects the pipeline label if the result changes the verdict.

The wait for that outcome is bounded by `ci.maxWaitMinutes` (default 40). When it expires with checks still running, the agent stops waiting, runs the local validation gate as its own evidence, posts that together with the still-pending check names and an explicit statement that no further follow-up is coming, drops `ci-monitoring`, and finishes.

A red signal does not short-circuit the review either. A failing required check or a conflicted head is collected as a **blocker finding** and reported together with the full code review, never instead of it: one review cycle gives the author the failing check, the conflict, and every code finding at once, rather than the cheapest red flag first and another cycle to discover the rest. Such a verdict is still `changes-requested` — completeness changed, the gate did not.

None of this touches the merge gates. Reporting early is safe; merging early is not — required checks still gate every merge, and the merge tooling refuses until they are genuinely green.

## The automation contract

The `om-auto-*` skills run this process unattended and are chainable: each accepts the artifact the previous one produced (an issue id, a spec path, or a PR number from the `PR: #<number> (link: <url>)` reference line every PR-producing skill emits), and each detects work already started — an open PR referencing the issue or plan — and continues on it rather than opening a duplicate. A completed autonomous run leaves a **ready** (non-draft), fully labeled PR — one pipeline label, category, QA meta, one priority, one risk — with a run-summary comment and, for user-facing changes, screenshots from the working app attached as PR evidence. Draft PRs are reserved for explicitly incomplete states: spec-only design PRs, interrupted hand-offs, or autonomous defaults flagged for human confirmation. Automation never applies `qa-approved`.

Two properties bound the whole unattended loop, and both are worth stating plainly because they are what make it safe to leave running:

- **Nothing merges automatically.** No automation calls `om-approve-merge-pr`. The pipeline's output is a reviewed PR; the merge is a human act.
- **The cap is on inventory, not on rate.** The scheduled pick takes nothing while three agent PRs are open, so a burst of intake cannot outrun review capacity. Raising throughput means reviewing, not tuning the schedule.

## Unattended decisions

The `afk-*` skills (`.ai/skills/`) run with no human to ask. Where a person would be consulted, the skill picks the most reversible reasonable option and records it as a row in a **Resolved assumptions** table (`# | Question | Applied default | Why`) in the brief, spec or PR body it writes. Humans review those rows at the PR, and overturning one is an ordinary review finding. Domain terms and decisions follow `afk-domain-modeling`: `CONTEXT.md` is updated in the same change, and ADRs are written only when a decision is hard to reverse, surprising, and a real trade-off.

### Delegated decisions

A choice between options is not a reason to stop or to hand an issue to a person. An unattended skill that would present options, a "Decision for the implementer", a "human's call" or a `blocked` hold hands the question to an **independent specialist sub-agent** instead (product owner, software architect, security and tenancy, accessibility and UX, test engineer, or configuration guardian), applies the verdict, records it as a Resolved assumptions row, and continues the work in the same run. The protocol, the verdict format and the short list of cases that still need a person are in `.ai/skills/afk-decide/SKILL.md`. A skill that stops on a question this protocol could settle is a defect to fix in the skill.

A state an unattended pipeline can enter needs an exit that does not require a human to type something. When a state's only on-by-default exit is a person noticing it, work accumulates there silently: name the exit when the state is introduced, or do not introduce the state.

## Validation gate

Every PR passes the full validation gate before review sign-off. **The command list lives in exactly one place: `.ai/agentic.config.json` → `validation.commands`, in order.** This section deliberately does not repeat it, and neither should `AGENTS.md`, `CONTRIBUTING.md`, a skill, or a workflow file — a gate written down twice is a gate that disagrees with itself, and the copy an agent happens to read is the one that wins.

Any non-zero exit fails the gate and blocks the PR. The implementing skills run the configured gate before opening a PR, and `om-check-and-commit` runs it before pushing a hand-worked branch. Changing the gate means editing that one key; anything that needs the list at runtime reads it from there.

## Repo automations

The cezar cockpit runs this process unattended: an automation watches GitHub for one event, and launches one workflow from `.ai/cezar/workflows/` when a record matches its filters. The automations this repository runs are tabulated in `## This repository`; the definitions are committed, and the cockpit's copy under `.ai/cezar/` is runtime state that is rebuilt from them.

These operating rules were learned the hard way and apply to every repository running the cockpit:

- **`maxRecords` is an evaluation budget, not a launch cap.** A poll turns each record into observations — one per opened event, one per reconstructed label event — sorts them oldest-first and evaluates only the first `maxRecords`. A triage run applies four labels within seconds and the decisive one lands last, so a small budget evaluates the noise and never reaches the label that matters: the trigger reads as dead. Keep the schema default of 25. Cost is bounded by the WIP limit and the per-skill caps, never by starving this budget.
- **A repo-local skill is not invocable by name.** The cockpit injects a step's skill body as the agent's system prompt, but materializes only a _team_ skill into `.claude/skills/`. An agent that sees an `afk-*` name and calls the `Skill` tool gets `Unknown skill` and must recover on its own. So write an `afk-*` skill that never asks to be invoked, and point cross-references at `.ai/skills/<name>/SKILL.md` rather than naming a skill as something to load.
- **A cause is not established until an experiment reproduces it.** State a mechanism as a hypothesis until a controlled run reproduces it, and cite that run.
- **A substring match and a success banner are not evidence; read the field the system writes.** Searching a run's NDJSON for a token matches the _content_ of events — including files the agent read while it worked — not the system's own telemetry. The authoritative reading is each event's `type`. The shell form of the same error: capture an exit status before anything else runs, and when a search matches, confirm which field matched before concluding anything from it.
- **Never file an issue carrying the label that triggers its own automation.** The opened event and the label event are two records in one batch, and the receipt that prevents a relaunch keys on the automation plus the event rather than on the issue, so two concurrent runs start on one ticket.
- **Pausing an automation and enabling it again silently drops everything that arrived in between.** `enable` sets `baselineAt` to now and moves the cursor with it, and every candidate at or below the baseline is discarded. That is deliberate on a first enable — a backlog is never launched — and a trap for an operator who paused to investigate. To act on an item already pending, use `cez automation check <id> --execute`, which launches it without touching the baseline.
- **An automation resolves its workflow from the working tree, so switching branches disables every automation.** A branch that does not carry `.ai/cezar/workflows/` empties the directory, and the next poll logs `unknown workflow`. Switching back does not undo it: failures back off `60 s × 2^(failures-1)` capped at six hours. Treat any branch switch in the main checkout as pausing every automation, and read the log after one.
- **A failed launch still consumes the event: the receipt is reserved before the run starts and never released.** An event that failed for a transient reason is suppressed permanently — every later poll reports `duplicate`. Recovery is manual: delete the matching lines from `.ai/cezar/automation-receipts.ndjson`, which is runtime state, and re-check.
- **Read an automation's next poll time from its state file; never compute it.** Any operation that rewrites the working tree must run between polls. The authoritative value is `nextCheckAt` for that automation in `.ai/cezar/automation-state.json`. Read it, and abort when the margin is thin instead of trusting arithmetic over the system's recorded state.

**Bootstrap** on a running cockpit:

1. `cez automation create --file <definition>` for each definition. They are created paused.
2. `cez automation check <id>` for polls, or `cez automation run <id>` for schedules.
3. `cez automation enable <id>`.
4. After editing a definition, run `cez automation update <id> --file ...`.

The labels in `.ai/agentic.config.json` must exist first (`gh label create <label>`). To stop it all, `cez automation pause <id>`, or start the cockpit with `CEZ_AUTOMATIONS=0`.

## Amending this process

This document and `.ai/agentic.config.json` describe the same process: change them together, and re-run the `om-setup-agent-pipeline` skill when the toolchain or label taxonomy changes. Per-skill deviations — extra review rules, a different PR body template, an added gate step — belong in a repo-local skill of the same name at `.ai/skills/<skill-name>/SKILL.md`, which takes precedence over the installed skill (and can `@`-import or reference it to extend rather than replace it); local rules win, but a repo-local skill cannot grant what the installed skill's safety rules forbid.

Three amendment rules are specific to this document's shape:

- **A change above the `BEGIN per-repo` marker is a change to every repository that shares this document.** Make it in all of them, or make it in `## This repository` instead. `diff` between two repositories' files, truncated at that marker, must be empty. The marker is the boundary — never a section count, which goes stale the first time a section is added, and was wrong here for as long as it was written down. Name the marker in prose the way this bullet does, without its comment syntax: a second literal copy of it above the real one is a false cut point, and truncating there silently drops every line between the two.
- **A shared section may not point at a repo-relative path that is missing from any repository sharing it.** A bare path reads as "here", so a reader who follows it in a sibling finds nothing — that is how the intake-bridge spec, which exists in only one of these repositories, came to be cited as though it were local in every one of them. Name the repository that holds it, or move the sentence into `## This repository`. This binds a path a reader is sent to follow, not one named as an output the process writes or as a place that must _not_ repeat something.
- **This file deliberately diverges from the `om-setup-agent-pipeline` SDLC template** by naming the base branch, the merge mechanics, the QA routing and the automations once, in `## This repository`, instead of rendering them throughout. Re-running that skill must not push those values back into the shared sections.

<!-- BEGIN per-repo -->

## This repository

- **The base branch is `design4pro`.** Every PR targets it and is squash-merged into it; `main` is
  the release branch, which `design4pro` is promoted into as a separate, human-made step. `main` is
  **not** where day-to-day work lands, and a skill that reads `baseBranch` from
  `.ai/agentic.config.json` gets `design4pro`.
- **CI does not run on this branch yet.** `.github/workflows/ci.yml` triggers on `main` and
  `develop` only, so a PR into `design4pro` has no required checks: the validation gate an agent
  runs locally before opening the PR is currently the _only_ evidence, and a reviewer must read the
  gate output in the run summary rather than a green tick. Adding `design4pro` to the workflow's
  triggers is tracked in `.ai/specs/2026-09-17-afk-intake-bridge.md`.
- **Who starts a run.** No label does (ADR 0008). An issue a maintainer opens is triaged on the
  event, a ready issue is implemented by the two-hour schedule, and a person can start any
  workflow by hand from the cockpit.
- **Risk here.** `risk-high` means the runner seam (`packages/cezar/src/core/agent-runner.ts`),
  worktree and branch handling, the `.ai/cezar/` state file formats, the HTTP API surface and the
  `packages/contract` schemas, or broad cross-cutting edits. `priority-extreme` means the published
  CLI is broken for users (`npx cezar` fails), data loss in `.ai/cezar/`, or an active security
  incident.
- **QA routing.** Cockpit UI changes, new features and other user-facing behavior carry `needs-qa`;
  a `CEZ_DRY_RUN=1` session covers most cockpit flows without a real `claude` login. Docs-only,
  dependency-only, CI-only and test-only changes carry `skip-qa`. The separate real-browser suite is
  `npm run test:e2e`, which is not part of the validation gate and reports `TEST_E2E_STATUS=skipped`
  — loudly, and **not** as a pass — when the browser cannot be provisioned.
- **What a ticket contains** beyond the Definition of Ready: the domain terms of `CONTEXT.md`, and
  the decisions of `docs/adr/`.

### Automations

Workflows live in `.ai/cezar/workflows/`; the committed definitions are `.ai/automations/*.json`.

| Automation                 | Trigger                              | Workflow                                                                                                                                                                            |
| -------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `triage.json`              | `issue.opened`, or `blocked` removed | `triage` (`afk-triage`)                                                                                                                                                             |
| `implement-ticket.json`    | every 2 hours                        | `implement-ticket`: pick with `backlog-status.mjs --next`, read the brief, check blockers, implement test-first, validation gate (retried twice), `om-open-pr`, `om-auto-review-pr` |
| `spec-to-tickets.json`     | weekdays 07:00                       | `spec-to-tickets` (`afk-to-tickets`)                                                                                                                                                |
| `architecture-review.json` | Mondays 06:00                        | `architecture-review` (`afk-architecture-review`)                                                                                                                                   |
| `lessons.json`             | Fridays 16:00                        | `lessons` (`afk-lessons`)                                                                                                                                                           |

`triage.json` filters on `authors: ["rafalwolak"]`. That is a security gate, not a convenience: this
repository is public and a triage run holds Bash with no allowlist, so an issue body from anyone
else is never read as a prompt without a maintainer stepping in. The same list is what
`backlog-status.mjs` trusts, so such an issue is never picked by the schedule either.

**Guardrails:**

- Nothing merges automatically: no workflow uses `om-approve-merge-pr`.
- `backlog-status.mjs --next` picks nothing while three agent PRs are open, so one tick starts at
  most one issue.
- Triage briefs `risk-high` or `security` work, and `implement-ticket` claims it, only on a security and tenancy specialist's approving verdict (§ Delegated decisions); the PR is still never merged automatically.
- Every skill carries hard caps: one issue per triage, eight tickets per spec, three architecture
  issues, one lessons PR.
- The committed definitions in `.ai/automations/` are the source; the cockpit's
  `.ai/cezar/automations.json` is runtime state and has drifted from them before. Re-apply from the
  committed files rather than syncing the other way.

<!-- END per-repo -->
