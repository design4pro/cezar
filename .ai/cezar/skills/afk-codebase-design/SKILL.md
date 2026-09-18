---
name: afk-codebase-design
description: cezar's own half of the codebase-design skill - its dependency examples, the seams it already has, and the interfaces worth designing twice. Overrides the kit-rendered base of the same name; read that base for the vocabulary and the rules.
---

# AFK codebase design in cezar

**Read `.ai/skills/afk-codebase-design/SKILL.md` first.** That file is the shared half, rendered by the agent kit into every repository that uses this pipeline: the vocabulary (module, interface, depth, seam, adapter, leverage, locality), the five rules, the dependency-category skeleton, the design-it-twice procedure and the done-when. `afk-triage`, `afk-to-tickets` and `afk-architecture-review` read that path literally, so those terms are guaranteed to be the same everywhere.

This file is the other half: what is true only here. It shadows the rendered file by name in the cockpit's registry - `.ai/cezar/skills` is scanned before `.ai/skills` and the first of a name wins - so an agent that loads the skill by name gets **this** file and must read the rendered one alongside it. Neither half is complete on its own.

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

## Design it twice: which interfaces

Run the design-it-twice procedure from the shared file when a new or changed interface touches the runner seam, worktree handling, `.ai/cezar/` state formats, or the HTTP API.
