---
name: afk-decide
description: Settle an open question unattended by delegating it to an independent specialist sub-agent, then continue the work on its verdict. Use whenever an unattended skill would otherwise leave options for a human to choose from - a judgement call, a scope split, a label choice, a risk-high or security go/no-go, a deletion, a category.
---

# AFK decide

**These instructions are already in your system prompt, or you were pointed at this file.** Never call the `Skill` tool for an `afk-*` skill - a repo-local skill is not in the agent's registry, so the call fails with `Unknown skill`.

An unattended run has no human to ask. A choice between options is not a reason to stop, put a `blocked` hold on an issue, or leave "a human's call" in a ticket: it is a question for a specialist. You ask one, apply the answer, record it, and keep working.

## 1. When to use it

Use it every time you are about to do any of these:
- post options, a "Decision for the implementer", a "human's call" or a "Why not an agent" line;
- add `blocked` or record `not-ready` for any reason other than those in step 5;
- stop a run because a product, design, architecture, scope, risk or security question is open.

Do not use it for a question that has one defensible answer in the code, the spec, an ADR or `CONTEXT.md`. Read those first and apply what they say.

## 2. Frame the question

Write a decision brief, neutral and self-contained, into the run's scratch directory (`$TMPDIR`):
- **Question:** one sentence.
- **Context:** the issue, spec or PR, and the constraints you verified, with file paths and the ADRs in play.
- **Options:** two to four, each with its consequence and how reversible it is. Include "do less now, file the rest as a follow-up" when a smaller slice is possible.
- **Evidence:** what you read and ran.

Do **not** state which option you prefer. The specialist is independent only if it forms its own view from the evidence.

## 3. Ask the specialist

Spawn **one** sub-agent with the `Agent` tool. Pick the specialist by the question:

| Question | Specialist |
|---|---|
| Product scope, what the user was promised, splitting a ticket, a category or priority | product owner |
| Module shape, seams, test deletion, ADR conflict, a dependency | software architect |
| `risk-high`, `security`, tenancy, auth, secrets, data loss | security and tenancy reviewer |
| Accessibility, copy, UX, i18n | accessibility and UX specialist |
| Test strategy, reproducibility, QA coverage | test engineer |
| A change to agent or project configuration (workflows, automations, skills, `.claude/`, hooks, `.husky/`) | configuration guardian |

When `.claude/agents/` defines a matching agent, use it as `subagent_type`. Otherwise use `general-purpose` and open the prompt with the role, for example: "You are an independent senior software architect reviewing a decision for an unattended pipeline."

The prompt carries the path to the decision brief, and it asks the specialist to:
1. verify the brief's claims against the repository read-only, and name any it finds wrong;
2. choose exactly one option, or a better one it names, applying `SDLC.md` § Unattended decisions: prefer the most reversible reasonable option that still ships a complete slice;
3. answer in this shape:

```md
VERDICT: <chosen option, one line>
CONFIDENCE: high | medium | low
WHY: <two to five sentences, citing files or ADRs>
CONDITIONS: <what the implementation must do for this to hold, or "none">
ESCALATE: no | yes - <the only reason a human is needed>
```

The configuration guardian also checks that a configuration change grants no more than the task needs, removes no deny rule for secrets or destructive commands, and weakens no guard. It answers `ESCALATE: yes` when either happens.

## 4. Apply the verdict

- `ESCALATE: no`: act on the verdict now, in this same run, and meet its CONDITIONS.
- `CONFIDENCE: low`: ask a second specialist from a different row. When the two disagree, take the more reversible option.
- `ESCALATE: yes` is valid only for the cases in step 5. Otherwise treat it as `no` and apply the verdict.

Record every verdict as a row in the Resolved assumptions table of the brief, spec, PR body or handoff you are writing:

| # | Question | Applied default | Why |
|---|---|---|---|
| n | <question> | <verdict> | Decided by <specialist> sub-agent (confidence <level>): <why> |

A human who disagrees overturns the row in review. That is an ordinary review finding, and it costs less than a stalled queue.

## 5. What still goes to a human

Only what no agent in this pipeline can do:
- an action that needs a person's own credentials, account settings, payment, or a legal commitment;
- merging a PR, closing an issue, or removing a label a human set;
- information only the reporter has: a repro, a version, what they expected;
- a platform limit, such as GitHub refusing to let the author approve their own PR;
- a security and tenancy specialist that does not approve `risk-high` or `security` work for unattended implementation: it gets no Agent Brief and no claim; add `blocked` and state the verdict and its reasons in a 🤖 comment;
- a write Claude Code refuses under `dontAsk` (protected configuration). Put the exact patch and the guardian's verdict in the report or PR, so applying it is one step for a human.

Everything else is decided here.

## Done when

The question has a verdict, the work continued on it in this run, and the verdict is a Resolved assumptions row.
