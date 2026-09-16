---
name: afk-codebase-design
description: Shared vocabulary and rules for designing deep modules in cezar - module, interface, depth, seam, adapter, leverage, locality, the deletion test. Use when designing or changing a module's interface, choosing where a seam or test goes, judging whether an abstraction earns its keep, or when another skill (afk-architecture-review, afk-to-tickets) needs this vocabulary.
---

# AFK codebase design

**These instructions are already in your system prompt.** Never call the `Skill` tool for an `afk-*` skill - a repo-local skill is not in the agent's registry, so the call fails with `Unknown skill`.

Adapted from mattpocock/skills `codebase-design` for unattended runs. Use these words exactly in designs, briefs, review findings and PR bodies. Do not substitute "component", "service", "API" or "boundary".

## Vocabulary

- **Module**: anything with an interface and an implementation, at any scale: a function, a file, a package, a runner.
- **Interface**: everything a caller must know to use the module correctly: types, invariants, ordering, error modes, required state, performance. Not just the TypeScript signature.
- **Implementation**: the code behind the interface.
- **Depth**: behaviour a caller or test can exercise per unit of interface it must learn. Deep = small interface, lots of behaviour. Shallow = interface nearly as complex as what it hides.
- **Seam**: the place where behaviour can change without editing that place; where an interface lives.
- **Adapter**: a concrete thing that fills a seam.
- **Leverage**: what callers gain from depth.
- **Locality**: what maintainers gain from depth: change, bugs and verification concentrate in one place.

## Rules

- **Deletion test.** Imagine deleting the module. If the complexity vanishes, it was a pass-through: inline it. If the complexity reappears across callers, it earns its keep.
- **The interface is the test surface.** Tests cross the same seam callers do. Needing to test past the interface means the module is the wrong shape.
- **One adapter is a hypothetical seam; two adapters are a real one.** Do not add a seam until something actually varies across it.
- **Accept dependencies, return results.** Pass collaborators in and return values rather than mutating shared state, so the seam is testable.
- **Replace, don't layer.** When you deepen a module, delete the shallow tests it makes redundant instead of keeping both.

## Dependency categories (where to put the seam)

| Category | Example in cezar | Test with |
|---|---|---|
| In-process | label taxonomy, workflow step validation | the real code |
| Local, substitutable | `.ai/cezar/` state files, git worktrees | a temp directory |
| Remote you own | the cockpit HTTP API | the zod contract in `packages/contract` + an in-process server |
| True external | `gh`, `claude` / `codex` / `opencode` / `pi` CLIs | a fake at the runner seam or the tracker operation |

## Seams cezar already has

Build on these before inventing new ones:
- The runner seam: `AgentRunner` / `AgentSession`, described in `AGENT_PROTOCOL.md`. Backend parity is enforced by `ui-parity.test.ts`.
- The HTTP contract: zod schemas in `packages/contract`, validated at every boundary (`CODE_REVIEW.md`).
- Tracker operations in `.ai/trackers/github.md`.

## Design it twice (risk-high interfaces only)

Use this when a new or changed interface touches something SDLC.md marks `risk-high`: the runner seam, worktree handling, `.ai/cezar/` state formats, or the HTTP API.
1. Dispatch two child tasks with `cez task create`. Constrain one to the smallest possible interface and the other to the most common caller's convenience.
2. Compare their designs on depth, locality and seam placement. Pick one, or a merge of both.
3. Record the choice and the rejected design as a row in the Resolved assumptions table.

If dispatch is unavailable, write both designs yourself, in sequence, before choosing.

## Done when

The design or finding names the module, its interface, and its seam in these terms, and states which rule above justifies the change.
