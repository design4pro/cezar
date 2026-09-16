# One git worktree per task, failing closed

Every task runs in its own git worktree on its own branch, forked from the base branch. When isolation cannot be set up, the task fails rather than falling back to the project's root. Its changes reach the user only through a PR or a manual merge. We chose this so that parallel tasks, variants and child tasks can never overwrite each other or the user's working tree (`.ai/specs/006-worktree-queue.md`, hardened in #438).

## Considered Options

- **Run in the user's directory:** kept only as an opt-in in-place task that holds a repository lease (#438; `CEZ_DISABLE_REPO_LOCK=1`, #762).
- **Silently fall back to the root when a worktree fails:** rejected in #438, because it is the one failure that destroys user work.
- **Delete the branch when reclaiming a worktree:** rejected in #483, because it loses local-only work. Retention reclaims the directory and keeps the branch.

## Consequences

Each task costs a checkout on disk, hence retention and reclaim (#483). Diff attribution needs a resolved base (#591, #751). Concurrent forks contend for the shared git config lock. The personal agent config has to be seeded into each worktree.
