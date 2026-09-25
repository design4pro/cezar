# Ride the vendor CLI logins; never hold API keys

cezar runs agents by shelling out to the `claude`, `codex`, `opencode` and `pi` CLIs, and to `gh`, each already logged in on the host. It never asks for, stores or uses an API key. An orchestrator would normally call model APIs directly. We chose the host's CLIs so that cezar needs no accounts or secrets and runs on the user's existing subscriptions (`.ai/specs/000-plan.md` principle 5; `.ai/specs/2026-07-22-provider-authentication.md`).

## Consequences

- cezar depends on each CLI's headless protocol and output format, so every runner maps its stream onto one event protocol with golden-fixture tests (`AGENT_PROTOCOL.md`).
- Tool permissions differ per runner: Codex and OpenCode ignore `allowedTools` (#430).
- Cost is whatever the provider reports, not an enforced dollar cap.
- Child processes get an allowlisted environment, and provider API keys are dropped by default (#427).
- A second account means a second CLI home (`.ai/specs/2026-07-29-agent-profiles.md`), not a stored credential.
