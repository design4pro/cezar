# Dispatch goes through a CLI, with the brakes in the engine

A running task starts child tasks with `cez task create`, and a child answers with `cez task report`. Each child runs in its own worktree forked from its parent's branch. The engine enforces the brakes: four children in flight, and budgets carved from the parent's. The hierarchy is flat: there are no ranks or missions. Everywhere else cezar uses turn-end markers, so a CLI is the surprising choice here. We chose it because markers caused every fatal refusal in the first missions, while a CLI call gets a synchronous, typed answer (`.ai/specs/2026-09-10-dispatch.md` A1).

## Considered Options

- **Turn-end markers (`CEZ:SPAWN`, `CEZ:REPORT`):** rejected, for the reason above.
- **Missions and units with ranks:** removed after research found that hierarchy helps only on independent parallel work and hurts on coupled work (`.ai/specs/units-research/00-verdict.md`).
- **Off by default:** reversed on 2026-09-12. With dispatch off, an agent fanned out through its own sub-agents instead, unbudgeted and invisible (live run 3f7eaf02, 4.3M tokens).

## Consequences

- A task needs the cockpit's API (`CEZ_API_URL`) to dispatch, so a headless `cezar run` never does.
- Dispatch trees communicate through `.ai/cezar/dispatch/<root>/`, which is a protected state path.
- Dispatch is the biggest multiplier of cost: one task can start four more agents.
