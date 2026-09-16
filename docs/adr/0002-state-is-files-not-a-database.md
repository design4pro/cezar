# State is plain files that are written, never required

cezar keeps all of its state as plain JSON, NDJSON and Markdown under `.ai/cezar/`, `~/.cezar/` and `~/.cache/cez/`. It needs no database and no configuration file, and it rebuilds whatever a user deletes. A newcomer would expect SQLite or a config wizard. We chose files so that setup costs nothing and a user can read state with `cat` and fix it in an editor (`.ai/specs/000-plan.md` principle 4; AGENTS.md § Zero config).

## Consequences

- The files are the compatibility contract (`BACKWARD_COMPATIBILITY.md` §3, §9). Every new persisted field is optional, NDJSON is append-only, and old event types replay forever.
- There is no query layer: cross-project views are built in memory.
- Two cockpits or two CLI versions can write the same file, so writers use read-modify-write merges, tmp+rename, `.passthrough()` schemas and per-entry salvage.
- Deliberate exceptions: the `~/.cezar/config.json.bak` snapshot, and the gitignored `.ai/cezar/.gitignore` allowlist that keeps runtime files out of a user's `git status`.
