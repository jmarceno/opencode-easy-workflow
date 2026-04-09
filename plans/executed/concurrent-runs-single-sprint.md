# Concurrent Runs Single Sprint

## Goal

Allow users to start a standalone task run or a new workflow run while other runs are active, as long as the configured parallel slot limit allows it.

This sprint intentionally uses the simplest workable model:

- `parallelTasks` is redefined to mean `max concurrent workflow/task runs`
- each started workflow or standalone task creates one persisted run row in the database
- a run consumes one slot while its status is `running`
- if all slots are consumed, new starts are rejected
- tasks remain editable until the moment they actually begin executing
- the UI shows running runs in a collapsible panel with per-run controls
- stale runs found on startup are marked failed and their last task goes through smart repair

## Scope

### In

- add persisted `workflow_runs` state to SQLite
- create one run row for `start all` and one run row for `start single`
- execute each run sequentially using the stored task order
- admit or reject starts based on active run count versus `options.parallelTasks`
- expose run list and per-run `pause`, `resume`, `stop` controls over HTTP and WebSocket
- remove the global mutation lock that blocks task editing during unrelated execution
- block task edits only for the task currently executing inside an active run
- recover stale running/paused runs on startup
- automatically mark stale runs failed and send the last active task to smart repair
- add tests for slot admission, editability, run controls, and stale recovery

### Out

- queueing starts when capacity is full
- immediate hard-stop of an in-flight task session
- large rewrite of the existing task execution internals
- reworking best-of-n semantics beyond making it run inside the new per-run model
- full workflow-review bridge/runtime redesign beyond what is needed for the new run state model

## Data Model

Add a `workflow_runs` table with fields:

- `id`
- `kind` (`all_tasks`, `single_task`, `workflow_review`)
- `status` (`running`, `paused`, `stopping`, `completed`, `failed`)
- `task_order_json`
- `current_task_id`
- `current_task_index`
- `started_at`
- `updated_at`
- `finished_at`
- `pause_requested`
- `stop_requested`
- `error_message`

The run row is the source of truth for:

- whether a slot is consumed
- which task is currently active
- where the run should resume after pause/restart

## Execution Model

Use a small run manager that:

1. counts active running rows to decide whether a start can be admitted
2. creates a run row with the selected task IDs in stored order
3. spins one orchestrator instance per active run
4. executes the run task list sequentially
5. updates `current_task_id` and `current_task_index` as progress advances
6. stops starting new tasks when pause or stop is requested

Per-run semantics:

- `pause`: finish the current task, then mark the run `paused`
- `resume`: continue from `current_task_index`
- `stop`: finish the current task, then mark the run `failed` with a stop message

## Task Editing Rules

Remove the old global execution lock.

New rule:

- any task may be edited, deleted, or reordered while runs exist
- except the task that is currently executing inside an active run

Reason:

- the run row already stores task IDs and order
- tasks that have not started yet should remain editable

## Startup Recovery

On startup:

1. find any run rows still marked `running`, `paused`, or `stopping`
2. mark those runs `failed` with a stale-run message
3. for each affected run, look at `current_task_id`
4. if that task still exists, run smart repair to decide resume/reset/done/fail next state
5. surface the failed run in the UI so the user can restart or inspect it

## API/UI Changes

Add APIs:

- `GET /api/runs`
- `POST /api/runs/:id/pause`
- `POST /api/runs/:id/resume`
- `POST /api/runs/:id/stop`

Keep:

- `POST /api/start`
- `POST /api/tasks/:id/start`

But change them to create run rows instead of relying on a singleton executor.

UI changes:

- replace the old global start/stop mental model with a collapsible running-runs panel
- show run kind, status, current task, progress, and stop/pause/resume actions
- keep task cards startable while capacity remains and the specific task is not actively executing

## Test Plan

Add or update tests for:

1. starting a second run while one is active when slots are available
2. rejecting starts when all slots are consumed
3. editing unrelated tasks while another run is active
4. blocking edits to the specific active task only
5. pause after current task completes
6. resume continuing from the next task index
7. stop marking the run failed after the current task ends
8. startup stale-run recovery marking runs failed
9. startup stale-run recovery invoking smart repair for the last active task

## Implementation Order

1. add DB schema and types for `workflow_runs`
2. add run manager and stale-run recovery
3. adapt orchestrator use so one run executes sequentially
4. update server APIs and WebSocket events
5. remove global mutation lock and switch to active-task-only blocking
6. add the running-runs UI panel and controls
7. add tests and fix regressions
