/**
 * The suite runs inside a cezar task as often as it runs on a clean machine — the
 * validation gate mandates it, so every implement task executes it in a checkout whose
 * environment already names THAT task's handoff journal and follow-ups file.
 *
 * Those two variables are honoured by the dry-run mock agent by design (it appends a
 * progress entry and a follow-up so the Inbox loop is testable without tokens), and every
 * runner spawns its child with `{ ...process.env, ...spec.env }`. A case that builds a
 * runner on the mock binary and passes no environment of its own therefore hands the mock
 * the live task's own state to write — a fabricated "implemented the change" entry in the
 * journal an agent reads back to recover context after a restart, and a follow-up stamped
 * with the live task's id.
 *
 * Shadowing with `''` rather than deleting is deliberate, and mirrors what the run
 * machinery does for the same reason (`agentEnv` in `src/workflows/run.ts`): a runner
 * spreads the parent environment, so only a key that is PRESENT and falsy reliably
 * overrides an inherited one. It is also what makes the guard pinnable — an absent key is
 * indistinguishable from a clean CI machine, an empty one is proof the scrub ran.
 *
 * Deliberately applied ONCE, at setup-module load, before any suite's `beforeAll`. A
 * per-test scrub would silently gut the suites that set these variables themselves to
 * simulate a nested cezar (`src/workflows/system-prompt.test.ts`): they would still pass,
 * while no longer testing inheritance at all.
 */
export const scrubInheritedRunState = (env: NodeJS.ProcessEnv): void => {
  env.CEZ_HANDOFF_FILE = '';
  env.CEZ_TODOS_FILE = '';
};
