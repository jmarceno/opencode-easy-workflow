# Pi Migration From OpenCode

## Goal

Build a new Pi-based Easy Workflow implementation in a new project directory inside this repository, while reusing the existing kanban UI and preserving the feature set that exists today.

This is a migration plan to a working solution first, not a perfect redesign.

## Hard Rules

- all new Pi migration code goes under `pi-easy-workflow/`

## Core Decisions

- do not replace the current OpenCode implementation in place
- create a new project directory under this repository at `pi-easy-workflow/`
- keep the current server-owned workflow model: user starts our server directly and our server serves the kanban UI
- keep the current UI as the MVP blueprint and preserve its feature expectations
- use Pi as the execution engine through RPC mode, with one Pi process per active workflow-owned session
- make the server the system of record for workflow state, session state, and session history

## Non-Negotiable Requirements

- keep all features we have today
- capture all Pi output with no gaps tolerated
- store all session data we receive into the database
- store the prompts that replace the current agents in the database
- keep skills file-based and make them available to Pi via an install or sync script
- avoid MVP permission stalls by bypassing permission gates rather than building a fine-grained approval system

## Target Project Layout

Create a new project directory at:

- `pi-easy-workflow/`

Initial expected structure:

- `pi-easy-workflow/src/`
- `pi-easy-workflow/src/kanban/`
- `pi-easy-workflow/src/runtime/`
- `pi-easy-workflow/src/db/`
- `pi-easy-workflow/src/prompts/`
- `pi-easy-workflow/skills/`
- `pi-easy-workflow/scripts/`
- `pi-easy-workflow/tests/`
- `pi-easy-workflow/.pi/`

The existing repository remains the migration source. Reuse code by copying the minimum viable set of files and then continue independently inside the new project directory while keeping everything tracked by the parent repo.

## What We Reuse

Reuse or adapt from the current implementation:

- kanban HTML and client logic from `src/kanban/index.html`
- task, run, candidate, and workflow state concepts from `src/types.ts`
- dependency and execution graph logic from `src/execution-plan.ts`
- workflow run manager concepts from `src/run-manager.ts`
- repair and execution state rules from `src/task-state.ts`
- server API patterns from `src/server.ts`
- SQLite persistence patterns from `src/db.ts`
- best-of-n orchestration concepts from `src/orchestrator.ts`
- Telegram notification behavior where still needed

Do not carry over:

- OpenCode plugin bridge
- OpenCode SDK client usage
- OpenCode session URLs
- OpenCode event forwarding pipeline

## New Runtime Model

The new server owns orchestration and persistence. Pi is a child process runtime.

Per active session:

1. server allocates a local workflow session id
2. server creates or attaches a worktree when needed
3. server spawns a Pi RPC process
4. server sends RPC commands over stdin
5. server captures stdout JSONL and stderr completely
6. server stores raw records first, then projects them into normalized message and timeline rows
7. server updates task and run state and broadcasts websocket updates to the UI

Use one Pi process per active workflow-owned session, including:

- standard task execution sessions
- plan-mode planning sessions or controlled continuations
- review scratch sessions
- best-of-n worker sessions
- best-of-n reviewer sessions
- best-of-n final-applier sessions
- repair sessions

This preserves parallel execution, isolation, and run-level visibility.

## Session Capture Requirements

The database must be the primary store for session data.

Store all session data we receive, including:

- every outbound RPC command we send to Pi
- every inbound RPC response from Pi
- every inbound RPC event from Pi
- every stderr chunk
- process lifecycle transitions
- session snapshots requested by the server such as `get_state` and `get_messages`
- rendered prompts sent to Pi

Do not rely only on a normalized timeline table. Keep both raw and projected forms.

## Database Plan

Add or adapt tables for the new project directory.

### `workflow_sessions`

Source of truth for session ownership and lifecycle.

Suggested fields:

- `id`
- `task_id`
- `task_run_id`
- `session_kind`
- `status`
- `cwd`
- `worktree_dir`
- `branch`
- `pi_session_id`
- `pi_session_file`
- `process_pid`
- `model`
- `thinking_level`
- `started_at`
- `updated_at`
- `finished_at`
- `exit_code`
- `exit_signal`
- `error_message`

### `session_io`

Append-only raw capture table.

Suggested fields:

- `id`
- `session_id`
- `seq`
- `stream` (`stdin`, `stdout`, `stderr`, `server`)
- `record_type` (`rpc_command`, `rpc_response`, `rpc_event`, `stderr_chunk`, `lifecycle`, `snapshot`)
- `payload_json`
- `payload_text`
- `created_at`

### `session_messages`

Normalized projection for UI timeline, review, debugging, and repair.

Populate from `session_io` plus explicit server-side context.

### `prompt_templates`

Canonical DB-backed prompt store.

Suggested seed keys:

- `execution`
- `planning`
- `plan_revision`
- `review`
- `review_fix`
- `repair`
- `best_of_n_worker`
- `best_of_n_reviewer`
- `best_of_n_final_applier`
- `commit`

### `prompt_template_versions` or equivalent

Optional for MVP, but leave room for version history.

## Prompt Migration Plan

The current `agents/*.md` content should become DB-backed prompt templates in the new project directory.

Rules:

- seed DB prompt templates from the current agent documents and prompt-building logic
- keep the runtime source of truth in the database
- store the fully rendered prompt text sent to Pi for each session or turn
- keep prompts detailed enough to preserve behavior, but do not recreate an agent framework for MVP

Current source material includes:

- `agents/workflow-build.md`
- `agents/workflow-plan.md`
- `agents/workflow-review.md`
- `agents/workflow-repair.md`
- the current inline prompt text in `src/orchestrator.ts`

## Skills Plan

Skills stay file-based.

Pi can load project-local skills from `.pi/skills/`, and can also load skills from configured paths.

For MVP:

- keep skills in `pi-easy-workflow/skills/`
- add a script that syncs or installs them into `pi-easy-workflow/.pi/skills/`
- add or update `pi-easy-workflow/.pi/settings.json` so Pi uses the project-local resource layout

This keeps skills local to the new implementation and avoids depending on global Pi configuration for project behavior.

## Permission Strategy

MVP should not build a permission system.

Pi's runtime is simpler than OpenCode here:

- Pi does not have built-in permission popups
- blocking happens only if an extension installs `tool_call` gates or similar checks

Therefore MVP permission bypass is:

- run Pi with `--no-extensions`
- do not load permission gate extensions
- use the user's existing Pi auth and model configuration for now

This prevents sessions from getting stuck waiting for approvals.

## Pi Runtime Defaults For MVP

- use Pi RPC mode
- use one process per session
- use `--no-extensions`
- keep skills project-local through the new project's `.pi/skills/`
- keep prompts server-owned and DB-backed rather than relying on Pi prompt discovery for core workflow behavior
- use the user's existing default Pi auth and models for fastest adoption

## Local Session Viewer

OpenCode session links disappear in the new model, so the MVP must provide a local realtime session viewer.

Requirements:

- preserve the current board affordance where card headers and run rows can open a session view
- point `sessionUrl` to a local route in our server and UI
- render from DB-backed session history plus websocket updates
- support live output streaming using the raw captured Pi event stream and normalized message projection
- MVP can be read-only

Recommended shape:

- keep the existing single-page board
- add a local session modal or route such as `/#session/<id>`
- use existing websocket infrastructure to push session updates

Future interaction can add:

- steer
- follow-up
- abort
- extension UI responses if we later introduce extensions

## Worktree Strategy

Replace OpenCode worktree APIs with direct git worktree management.

The new runtime layer should provide:

- create worktree
- remove worktree
- inspect git status and diff
- merge back to target branch
- keep or delete worktree based on task settings

This preserves the current isolated execution model and best-of-n fan-out behavior.

## Feature Preservation Map

### Standard execution

Preserve:

- one task per worktree
- pre-execution command support
- execution prompt
- auto-commit prompt
- merge and cleanup flow

### Plan mode

Preserve:

- planning pass
- auto-approve or wait for approval
- revision requests
- transition to implementation after approval

### Review loop

Preserve:

- separate review session
- strict JSON review result
- fix prompt loop
- stuck handling when review limits are exceeded

### Best-of-N

Preserve:

- worker fan-out
- reviewer fan-out
- final applier run
- candidate artifacts and summaries
- card-level summary and run detail visibility

### Repair and recovery

Preserve:

- deterministic repair fallbacks
- smart repair prompt
- stale run recovery on startup
- worktree-aware repair decisions

### Notifications

Preserve where useful:

- task status notifications
- workflow completion notifications
- later inbound reply routing once interactive sessions are added

## Implementation Order

### 1. Bootstrap the new project directory

- create `pi-easy-workflow/`
- copy the reusable UI and core logic skeletons
- create initial package, runtime, and test scaffolding

### 2. Add DB schema and migrations

- port task and workflow state tables
- add raw session capture tables
- add DB-backed prompt template tables
- add seed data for prompt templates

### 3. Build Pi process management

- spawn Pi in RPC mode
- capture stdout JSONL and stderr fully
- persist all records to DB
- provide command send and session shutdown handling

### 4. Build git worktree runtime

- create and remove worktrees directly
- support target branch selection
- preserve current merge and cleanup semantics

### 5. Build prompt rendering from DB templates

- migrate current agent and inline prompt content into templates
- render execution, plan, review, repair, and best-of-n prompts from DB
- store the rendered prompt text in DB when used

### 6. Port standard execution and plan mode

- implement standard task flow
- implement plan generation, approval, revision, and implementation transitions

### 7. Build local session viewer

- reuse the current UI shell
- replace external session links with local session routes
- show live Pi output from DB and websocket updates

### 8. Port review, repair, and recovery

- implement review loop on Pi
- implement smart repair using DB-backed session history and worktree state
- add startup stale run recovery

### 9. Port best-of-n

- implement worker, reviewer, and final-applier sessions on Pi
- preserve candidate and summary endpoints and UI behavior

### 10. Add Pi skill install and sync tooling

- sync `skills/` into `.pi/skills/`
- maintain `.pi/settings.json`
- keep project-local Pi resources reproducible

### 11. Verify end-to-end behavior

- run targeted tests for orchestration, review, best-of-n, repair, and session logging
- verify local session viewing works in realtime
- confirm session data completeness in the database

## Backlog Translation Rules

Backlog tasks created from this plan should:

- state clearly that they are part of the OpenCode to Pi migration
- reference this plan at `plans/pi-migration-from-opencode-to-pi.md`
- target branch `pi-migration`
- use `planmode = true`
- use `autoApprovePlan = true`
- use `autoCommit = true`
- keep prompts detailed but not bloated
- implement only inside `pi-easy-workflow/` unless copying source material from the legacy implementation is required
- list exact files or directories to create when the task is small
- include an explicit `Do not create anything else in this task` rule for bootstrap and scaffolding tasks
- include an explicit `Out of scope` section whenever a task could be misread as broader migration work

## Verification Requirements

The migration is not complete until the new project directory can demonstrate:

- task creation and dependency-aware execution
- plan mode with approval and revision flows
- review loop behavior
- best-of-n behavior
- local realtime session viewing
- full session data capture in DB
- DB-backed prompt templates in use
- project-local Pi skills installed and usable
- no permission stalls in MVP runtime

## Risks And Mitigations

### Risk: incomplete output capture

Mitigation:

- persist raw stdout JSONL lines before projection
- persist stderr separately
- use server-owned sequence numbers
- reconcile with `get_state` and `get_messages` snapshots at key boundaries

### Risk: user-installed Pi extensions interfere with runtime

Mitigation:

- launch with `--no-extensions` in MVP

### Risk: session viewer lacks enough fidelity

Mitigation:

- keep both raw and normalized records in DB
- drive the UI from the normalized view while allowing deeper inspection later from raw capture

### Risk: prompt migration loses behavior

Mitigation:

- seed DB templates directly from current agent docs and inline prompt logic
- store rendered prompt text for inspection and debugging

## Future Development

### Isolated Pi agent directory

After MVP, add a fully isolated Pi runtime directory using `PI_CODING_AGENT_DIR`.

Benefits:

- deterministic workflow runtime
- no accidental inheritance from user global settings or resources
- reproducible extensions, models, prompts, and skills layout

This should come after MVP because it requires bootstrapping auth, models, and settings into a workflow-owned Pi directory.

### Interactive session control

After MVP, add:

- session replies from the local viewer
- steer and follow-up controls
- stop or abort controls in the session view
- later Telegram reply routing to live sessions

### Prompt editing UI

After MVP, consider UI or API support to edit DB-backed prompt templates with versioning.
