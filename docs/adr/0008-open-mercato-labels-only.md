# The agent process uses the Open Mercato labels only

Status: proposed

This repository's own agent process (`SDLC.md`, `.ai/automations/`, `.ai/cezar/workflows/`, the `afk-*` skills) used to run two label families beside the Open Mercato taxonomy in `.ai/agentic.config.json`: the **intake labels** `needs-triage`, `needs-info`, `ready-for-agent` and `ready-for-human`, which said who acts on an issue next, and the **trigger labels** `groom`, `autofix`, `spec` and `review-threads`, which the shared `SDLC.md` described and this repository never wired. No Open Mercato skill reads either family, and each label needed its own automation, its own override text and its own rule about who may set it. The intake labels also had a gap nobody closed: nothing applied `needs-triage` after a groom, so an issue waited for a person to label it (`.ai/specs/2026-09-17-afk-intake-bridge.md`).

The owner's direction (2026-10-01, made first in planned.travel's ADR 0032 and ported here) is that the vocabulary is exactly `labels` in `.ai/agentic.config.json` - the Open Mercato taxonomy plus `do-not-close` - and that readiness is computed rather than labelled:

1. **An issue is ready** when it is open, a maintainer opened it (the `authors` gate of the issue automations), it was not filed from production error data (no `sentry-issue` marker), it carries an `## Agent Brief` (in a triage comment by a trusted author, or in the body of a ticket `afk-to-tickets` filed), it has a category, a priority and a risk, every issue under its `Blocked by` is closed, no open PR addresses it, no 🤖 not-ready or `STOP:` comment waits for an answer, and it carries none of `blocked`, `do-not-merge`, `do-not-close` or `in-progress`. `.ai/scripts/backlog-status.mjs` is the one implementation of that rule.
2. **A schedule starts implementation.** "Implement the next ready issue" runs `implement-ticket` every two hours. Its first step asks `backlog-status.mjs --next` for the highest-priority, oldest ready issue, and the script answers nothing while three agent PRs are open (every open PR a trusted author opened, except one carrying `do-not-merge`). An issue it refuses gets a `STOP:` comment, so the next tick does not pick it again.
3. **Opening an issue triages it.** "Triage new issues" runs `afk-triage` on `issue.opened` by the maintainer, and again when a person removes `blocked`. The outcome is an Agent Brief, or a hold.
4. **A person's hold is `blocked` plus a 🤖 comment** naming the one thing a person must do. It replaces `ready-for-human` and `needs-info`. A skill may set it; only a person clears it.
5. **`afk-to-tickets` writes each ticket's Agent Brief into its body.** A ticket becomes ready when its blockers close; there is nothing to promote.

## Considered Options

- **Keep the intake labels and wire the bridge** (`.ai/specs/2026-09-17-afk-intake-bridge.md`): rejected. It keeps a vocabulary no Open Mercato skill reads, and a label that says "ready" can disagree with the issue it sits on - a blocker reopens, a PR appears - where a computed rule cannot.
- **An event per ready issue instead of a schedule:** rejected. A ticket becomes ready when another issue closes, and no GitHub event on the ticket says so.

## Consequences

- Every issue the maintainer opens is triaged and, once ready, implemented and opened as a reviewed PR without a person in between. Nothing merges automatically; the brakes are the `authors` gate, the security and tenancy specialist's verdict that `risk-high` and `security` work needs before a claim, the WIP limit and `maxParallel`.
- An issue anyone else opened is never triaged or implemented by automation. A maintainer who vouches for one re-files it, or starts the run from the cockpit.
- Implementation is at most one issue per two hours, by design. A person who wants one sooner starts `implement-ticket` on it from the cockpit.
- The retired labels still exist on GitHub until a person removes them from open issues and deletes them; nothing in the process reads them any more.
