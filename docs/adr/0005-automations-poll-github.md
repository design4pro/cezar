# Automations poll GitHub through `gh`, never webhooks

A GitHub automation is a bounded poll through `gh api` that runs only while the cockpit is up. GitHub recommends webhooks for integrations. cezar binds to loopback and has no hosted callback, no account and no GitHub App, and it must not require a tunnel or repository configuration. So polling is the only option that stays zero-config (`.ai/specs/2026-07-25-github-automations.md`).

## Considered Options

- **Webhooks, or an external relay:** rejected, because they need a public listener or setup outside the repo.
- **A separate scheduler daemon:** rejected, because there must be no process to manage.

## Consequences

- An automation is only as fresh as its poll interval, and nothing fires while cezar is closed.
- Polling needs its own machinery: cursors, ETags, receipts for exactly-once launches, rate-limit backoff, a cross-process poll lock, and a baseline on enable so a backlog never launches.
- Automations became default-on on 2026-09-14. That is a reversible policy on top of this decision (AGENTS.md § Zero config; `.ai/specs/2026-09-14-automations-redesign.md`).
