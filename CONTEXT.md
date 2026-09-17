# cezar

cezar is a local cockpit that runs coding agents on tasks in a project's repository: many at once, each isolated, every step visible. This file is its domain glossary. Use these words in code, comments, specs, issues and PRs.

## Language

### Places

**Project**:
A folder, normally a git repository, registered with cezar. It owns its tasks, workflows, automations and state.
_Avoid_: repo (for the registered entry), workspace

**Repository**:
The git facts about a project's root: branch, remote, working-tree status, commits.
_Avoid_: project (for git state)

**Workspace**:
The per-user layer above all projects on one machine: the project registry and the global settings.
_Avoid_: project; never the build's npm workspaces

**Cockpit**:
The browser interface and its local server, where tasks are started, watched and reviewed.
_Avoid_: GUI, web UI, dashboard

### Tasks

**Task**:
The unit of work: a task prompt carried through a workflow by an agent, from queued to a settled outcome.
_Avoid_: job, mission, unit

**Run**:
The same entity as a task, named from the engine's side. Say it only in API, storage and engine code.
_Avoid_: run (for an automation's launch or for the headless command)

**Task prompt**:
The text a task was started with.
_Avoid_: task (for the text)

**Step**:
One link of a workflow inside a task, with its own status, session and cost. An **agent step** runs a prompt or skill through a runner. A **check step** runs a shell command that passes on exit 0 and may send the task back to an earlier step.

**Workflow**:
A named, ordered chain of steps a task follows.
_Avoid_: chain, pipeline

**Plan**:
A workflow an agent drafts for one task, run only once the user approves it.

**Skill**:
A Markdown playbook whose body becomes an agent step's extra instructions. It is found in the project, in the user's home, in a team skills repository, or built in.
_Avoid_: recipe, command

**Variant**:
One of two or three competing copies of the same task. Their diffs are compared and one is kept.
_Avoid_: group, fork

**Autonomous**:
Said of a task that never stops to ask or to wait for review. It continues until done or halted by a brake.

**Queue**:
The first-in-first-out line of tasks waiting for a free slot.

**Slot**:
Room for one task to run concurrently, bounded by both the workspace's and the project's parallel limits.

### Isolation

**Worktree**:
The isolated checkout and branch a task works in, forked from the base branch, so parallel tasks never share files.
_Avoid_: sandbox, clone

**In-place task**:
A task that works directly in the project's root instead of a worktree.

**Repository lease**:
Exclusive use of a project's root by one in-place task.
_Avoid_: lock

**Review gate**:
The optional resting state of a finished task with changes, until the user accepts it, sends it back, or opens a draft PR.

### Agents

**Runner**:
A locally installed agent CLI that carries out agent steps: Claude, Codex, OpenCode or pi.
_Avoid_: backend, engine

**Agent**:
The model working a task through a runner's session.
_Avoid_: runner

**Agent profile**:
One login of a runner, so a project or task can use a second account.
_Avoid_: agent account

**Session**:
One live conversation between a step and its runner.

**Continue**:
Reopening a task's session as a new step, with a further message.
_Avoid_: retry

**Marker**:
A control line an agent ends its turn with to tell cezar what happened: done, monitoring, a question, a PR.

**Ask**:
A structured multiple-choice question an agent puts to the user. It parks the task until answered.

**Waiting**:
The state of a task whose session is open and needs the user.
_Avoid_: blocked, paused

**Monitoring**:
The state of a running task whose agent is waiting on its own downstream work (child tasks, sub-agents, CI) and needs nothing from the user.
_Avoid_: waiting

**Handoff journal**:
A task's running notes (goal, progress, resume notes), shown as its Notes tab.
_Avoid_: handoff (alone)

**Follow-up**:
A suggestion for a new task that an agent leaves when it finishes, collected in the Inbox.
_Avoid_: todo, child task

### Dispatch

**Dispatch**:
A running task starting child tasks and receiving their reports.
_Avoid_: spawn, mission, delegate

**Root task**:
The task that started a dispatch tree.

**Child task**:
A task started by another task through dispatch. The starting task is its **parent task**.
_Avoid_: subtask, follow-up

**Dispatch kind**:
What a child task is for: `implement` (change code) or `review` (judge another task's branch and return a verdict).

**Report**:
A child task's structured result, delivered to its parent.

**Budget**:
A child task's spend ceiling in dollars, carved out of its parent's. Unspent budget returns to the parent.
_Avoid_: quota, limit

### Automations

**Automation**:
A stored rule that launches an ordinary task whenever its trigger fires. It is created paused.
_Avoid_: bot, hook, job

**Trigger**:
What fires an automation: a GitHub poll for issue or pull request events, or a schedule.
_Avoid_: webhook

**Launch**:
One task an automation started. Why it started (schedule, catch-up or manual) is its **launch reason**.
_Avoid_: run, trigger (for the reason)

**Receipt**:
The durable reservation an automation writes before a launch, so one event launches at most one task.

**Baseline**:
The instant an automation was enabled. Nothing older than it ever launches.

**Occurrence**:
One fire time of a schedule. A missed occurrence may fire once, as a catch-up.

### Delivery process

**Intake label**:
The one label on an issue that says who acts next: `needs-triage`, `needs-info`, `ready-for-agent` or `ready-for-human`.

**Agent Brief**:
The durable issue comment an agent implements from: current and desired behaviour, key interfaces, test seam, acceptance criteria, out of scope.

**Resolved assumptions**:
The table in which an unattended agent records each decision it made instead of asking.

**Ticket**:
An issue that is one tracer-bullet slice of a spec: narrow, but complete on its own, with explicit blocking edges.

**Frontier**:
The tickets whose blockers are all closed.

**Ladder**:
An ordered set of labels an issue climbs on its way to a pull request, and the automations that answer them. The **intake ladder** is the pipeline's own — `needs-triage` to `ready-for-agent` to an implementing run — and a **trigger label** is the parallel lever a human pulls instead. Say which ladder.
_Avoid_: pipeline (for this), track, funnel

**Bridge**:
The one edge that makes the intake ladder self-feeding: a groom that ends `READY_STATUS=ready` applies `needs-triage` as its last mutation, so nothing waits for a person to label a ready issue. Designed in `.ai/specs/2026-09-17-afk-intake-bridge.md`; not yet wired in any repository.
_Avoid_: hook, glue, handoff (that word is already taken)

### Words with more than one meaning

- **review**: the review gate, a `review` dispatch kind, a GitHub PR review, or the `review` pipeline label. Always qualify it.
- **kind**: of a step (agent or check), of a child task (implement or review), of a trigger (GitHub or schedule). Always qualify it.
- **handoff**: say handoff journal, or Continue, or "open in terminal". Never the bare word.
- **inbox**: the follow-ups Inbox, or a child task's dispatch inbox. Always qualify it.
