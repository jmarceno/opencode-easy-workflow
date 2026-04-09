---
name: workflow-task-setup
description: Convert any user-provided implementation plan or scope document into Easy Workflow kanban tasks with correct dependencies, states, and persistence.
compatibility: opencode
metadata:
  audience: agents
  workflow: easy-workflow
---

## What I do

- Turn any user-provided planning material into Easy Workflow tasks.
- Map steps and milestones into executable backlog tasks or reusable templates.
- Set dependencies, ordering, and task options so the workflow can run them correctly.
- Configure `standard` vs `best_of_n` execution strategy per task when needed.
- Explain and use the workflow's API, database layout, and state model accurately.

## When to use me

- The user wants tasks created from a plan, spec, issue, notes, checklist, design doc, or any other document that describes scope, ideas, or implementation steps.
- The user wants an existing document translated into kanban tasks.
- The user wants tasks normalized, split, merged, reordered, or reconfigured before execution.

## Core Behavior

- Prefer creating tasks, not starting execution, unless the user explicitly asks to run them.
- Prefer small, outcome-based tasks that can be completed and reviewed independently.
- Keep each task prompt self-contained enough that an execution agent can act on it without needing to rediscover the original plan.
- Use dependencies for real sequencing constraints, not just because steps are numbered.
- Create template tasks only when the user wants reusable blueprints; otherwise create backlog tasks.
- Reuse or update an existing task instead of creating a duplicate when the match is clear. If the match is ambiguous, ask.
- Use `best_of_n` only for tasks where multiple candidate implementations and convergence are useful; otherwise keep `standard`.
- Respect task archiving: tasks with execution history are archived, not hard deleted.

## Recommended Workflow

1. Read the source material and extract the real deliverables, constraints, and acceptance criteria.
2. Check existing tasks before creating new ones.
3. Split the work into the smallest useful execution units.
4. Decide whether each item should be a `template` or `backlog` task.
5. Add dependencies only where one task truly blocks another.
6. Create tasks in intended execution order, or reorder them afterward.
7. Verify the stored result by listing tasks again and summarizing the mapping back to the user.

## Task Shape

The workflow task model is defined in `src/types.ts`.

Required fields for useful task creation:

| Field | Meaning |
| --- | --- |
| `name` | Short card title shown on the board |
| `prompt` | Main execution instructions |

Common optional fields:

| Field | Meaning | Normal default |
| --- | --- | --- |
| `status` | Board state | `backlog` for runnable tasks, `template` for reusable blueprints |
| `branch` | Target git branch | Global workflow default branch |
| `planModel` | Planning model override | `default` |
| `executionModel` | Execution model override | `default` |
| `planmode` | Pause after planning and wait for approval | `false` |
| `autoApprovePlan` | Automatically approve plans without user review | `false` |
| `executionStrategy` | Execution mode (`standard` or `best_of_n`) | `standard` |
| `bestOfNConfig` | Best-of-N worker/reviewer/final-applier config | `null` unless strategy is `best_of_n` |
| `review` | Run review loop after implementation | `true` |
| `autoCommit` | Auto-commit on success | `true` |
| `deleteWorktree` | Remove worktree when task completes, resets, or is marked done. If `false`, worktree is preserved even on failure. | `true` |
| `requirements` | Array of blocking task ids | `[]` |
| `thinkingLevel` | Reasoning effort (`default`, `low`, `medium`, `high`) | `default` |
| `skipPermissionAsking` | Auto-reply to permission prompts | `true` |
| `maxReviewRunsOverride` | Per-task override for max review runs | `null` (uses global default) |

Advanced fields normally left alone on fresh task creation:

| Field | Meaning |
| --- | --- |
| `executionPhase` | Internal phase for plan-mode lifecycle: `not_started`, `plan_complete_waiting_approval`, `plan_revision_pending`, `implementation_pending`, `implementation_done` |
| `bestOfNSubstage` | Internal substage for best-of-n lifecycle |
| `awaitingPlanApproval` | Whether a plan-mode task is waiting for approval |
| `planRevisionCount` | Number of plan revision cycles |
| `agentOutput` | Accumulated agent output with tagged blocks |
| `reviewCount` | Review loop counter |
| `reviewActivity` | Current review status: `idle` or `running` |
| `sessionId` / `sessionUrl` | Linked OpenCode session |
| `worktreeDir` | Active worktree location |
| `errorMessage` | Failure detail |
| `smartRepairHints` | User-provided hints for smart repair |
| `completedAt` | Unix timestamp when done |
| `isArchived` | Whether task has been archived |
| `archivedAt` | When task was archived |

## State Model

Task status values:

| Status | Meaning |
| --- | --- |
| `template` | Reusable blueprint, not meant to execute directly |
| `backlog` | Ready for execution when dependencies are satisfied |
| `executing` | Currently running |
| `review` | Waiting for review or user attention |
| `done` | Finished successfully |
| `failed` | Execution failed |
| `stuck` | Review found unresolved gaps or the workflow could not continue |

Execution phase values:

| Phase | Meaning |
| --- | --- |
| `not_started` | Normal initial state |
| `plan_complete_waiting_approval` | Planning finished and the task is paused for approval |
| `plan_revision_pending` | User requested plan revision, waiting to re-plan |
| `implementation_pending` | Plan was approved and implementation can run |
| `implementation_done` | Implementation finished |

Best-of-N substage values:

| Substage | Meaning |
| --- | --- |
| `idle` | No active best-of-n internals running |
| `workers_running` | Worker candidates are running |
| `reviewers_running` | Reviewer runs are evaluating candidates |
| `final_apply_running` | Final applier is running and preparing merge result |
| `blocked_for_manual_review` | Automation paused for human decision |
| `completed` | Best-of-n flow finished successfully |

Important runtime rules from the server and orchestrator:

- A task is executable when `status = backlog` and `executionPhase != plan_complete_waiting_approval`.
- A plan-mode task also becomes executable when `executionPhase = implementation_pending`.
- When a plan-mode task finishes planning, it moves to `status = review`, `awaitingPlanApproval = true`, `executionPhase = plan_complete_waiting_approval`.
- Approving that plan moves it to `status = backlog`, `awaitingPlanApproval = false`, `executionPhase = implementation_pending`.
- Requesting plan revision moves it to `executionPhase = plan_revision_pending` with the user's feedback appended as `[user-revision-request]`.
- Resetting a task to backlog clears it back to `executionPhase = not_started` and `awaitingPlanApproval = false`.
- Best-of-N and plan mode cannot be combined in v1 (`planmode = true` with `executionStrategy = best_of_n` is rejected by API validation).
- For `best_of_n`, the board still treats it as one logical task card while child runs are stored separately.
- `failed` and `stuck` appear in the review column in the UI, but they are distinct stored statuses.
- **Worktree preservation on failure**: When a task fails, the worktree is **NOT** automatically deleted. The worktree (and its partial/complete work) is preserved so users can inspect, debug, or recover their work. Worktrees are only deleted when:
  - Task completes successfully (if `deleteWorktree` is `true`, the default)
  - User explicitly resets a task to backlog (cleanup happens regardless of `deleteWorktree`)
  - User explicitly marks a task as done (cleanup happens if `deleteWorktree` is `true`)
- **Task Archiving**: Tasks with execution history are archived (soft deleted) rather than hard deleted. This preserves session logs and debugging information.

## Dependency Rules

- Dependencies are stored as task ids in `requirements`.
- The DB stores `requirements` as a JSON string, but the API uses a JSON array of strings.
- Only add a dependency when task B should not begin until task A is completed.
- Avoid artificial chains when tasks can be reviewed and executed independently.
- Circular dependencies will break scheduling.
- Tasks that are already outside the current executable set do not block batching the same way as active backlog items, so dependencies are most meaningful between active tasks you are setting up.

## Architecture Overview (v2.0+)

Easy Workflow uses a **standalone server + bridge plugin** architecture:

1. **Standalone Server** (`src/standalone.ts`) - Runs outside OpenCode
   - Provides HTTP API and WebSocket server
   - Manages SQLite database
   - Runs the task orchestrator with workflow run controls (pause/resume/stop)
   - Reads config from `.opencode/easy-workflow/config.json`

2. **Bridge Plugin** (`.opencode/plugins/easy-workflow.ts`) - Minimal plugin inside OpenCode
   - Forwards events (chat messages, permissions, session idle) to standalone server
   - Auto-replies to permissions for workflow sessions

3. **Configuration** (`.opencode/easy-workflow/config.json`)
   - `opencodeServerUrl`: OpenCode server URL
   - `kanbanPort`: Port where kanban UI is served
   - `projectDirectory`: Absolute path to project root

## Persistence Layout

The workflow DB is managed by the standalone server at:

`<workspace>/.opencode/easy-workflow/tasks.db`

The storage layer lives in `src/db.ts`.

Tables:

### `tasks`

| Column | Notes |
| --- | --- |
| `id` | Text primary key |
| `name` | Task name |
| `idx` | Board ordering |
| `prompt` | Task instructions |
| `branch` | Git branch |
| `plan_model` | Planning model |
| `execution_model` | Execution model |
| `planmode` | `0/1` boolean |
| `auto_approve_plan` | `0/1` boolean - auto approve plans |
| `review` | `0/1` boolean |
| `auto_commit` | `0/1` boolean |
| `delete_worktree` | `0/1` boolean |
| `status` | Task status string |
| `requirements` | JSON array string of task ids |
| `agent_output` | Aggregated output with tagged blocks |
| `review_count` | Number of review attempts |
| `session_id` | OpenCode session id |
| `session_url` | OpenCode session URL |
| `worktree_dir` | Worktree path |
| `error_message` | Failure details |
| `created_at` | Unix timestamp |
| `updated_at` | Unix timestamp |
| `completed_at` | Unix timestamp or null |
| `thinking_level` | `default`, `low`, `medium`, `high` |
| `execution_phase` | Internal plan-mode phase |
| `awaiting_plan_approval` | `0/1` boolean |
| `plan_revision_count` | Number of plan revisions |
| `execution_strategy` | `standard` or `best_of_n` |
| `best_of_n_config` | JSON config for worker/reviewer/final-applier runs |
| `best_of_n_substage` | Internal best-of-n substage |
| `skip_permission_asking` | `0/1` boolean |
| `max_review_runs_override` | Integer or null |
| `smart_repair_hints` | Text hints for smart repair |
| `review_activity` | `idle` or `running` |
| `is_archived` | `0/1` boolean |
| `archived_at` | Unix timestamp or null |

Indexes:

- `idx_tasks_status` on `status`
- `idx_tasks_idx` on `idx`

### `options`

Key-value store used for workflow defaults.

Important keys:

| Key | Meaning |
| --- | --- |
| `commit_prompt` | Commit instructions |
| `branch` | Default branch |
| `plan_model` | Default plan model |
| `execution_model` | Default execution model |
| `review_model` | Default review model |
| `repair_model` | Default repair model for smart repair |
| `command` | Pre-execution command |
| `parallel_tasks` | Parallelism limit |
| `port` | Kanban server port |
| `thinking_level` | Default thinking level |
| `auto_delete_normal_sessions` | Auto-delete normal sessions |
| `auto_delete_review_sessions` | Auto-delete review sessions |
| `show_execution_graph` | Show execution graph in UI |
| `telegram_bot_token` | Telegram bot token |
| `telegram_chat_id` | Telegram chat ID |
| `telegram_notifications_enabled` | Enable Telegram notifications |
| `max_reviews` | Default max review runs |
| `extra_prompt` | Extra prompt appended to all tasks |

### `task_runs`

Child run records for best-of-n internals.

| Column | Notes |
| --- | --- |
| `id` | Text primary key |
| `task_id` | Parent logical task id |
| `phase` | `worker`, `reviewer`, `final_applier` |
| `slot_index` / `attempt_index` | Expanded slot position and attempt |
| `model` | Model used for the run |
| `task_suffix` | Optional slot-specific prompt suffix |
| `status` | `pending`, `running`, `done`, `failed`, `skipped` |
| `session_id` / `session_url` | Session metadata |
| `worktree_dir` | Worktree path (kept on failure) |
| `summary` | Short run summary |
| `error_message` | Run-level error details |
| `candidate_id` | Linked candidate id (worker runs) |
| `metadata_json` | Structured metadata (reviewer output, verification, etc.) |

### `task_candidates`

Successful worker candidate artifacts for best-of-n.

| Column | Notes |
| --- | --- |
| `id` | Text primary key |
| `task_id` | Parent logical task id |
| `worker_run_id` | Source worker run |
| `status` | `available`, `selected`, `rejected` |
| `changed_files_json` | JSON array of changed file paths |
| `diff_stats_json` | JSON diff stats map |
| `verification_json` | JSON verification result |
| `summary` | Candidate summary |
| `error_message` | Candidate artifact error detail |

### `workflow_runs`

Workflow execution runs with pause/resume/stop controls.

| Column | Notes |
| --- | --- |
| `id` | Text primary key |
| `kind` | `all_tasks`, `single_task`, `workflow_review` |
| `status` | `running`, `paused`, `stopping`, `completed`, `failed` |
| `display_name` | Human-readable run name |
| `target_task_id` | Single task target (if kind is single_task) |
| `task_order_json` | JSON array of task IDs in execution order |
| `current_task_id` | Currently executing task |
| `current_task_index` | Index in task order |
| `pause_requested` | `0/1` boolean |
| `stop_requested` | `0/1` boolean |
| `error_message` | Run-level error |
| `created_at` / `started_at` / `updated_at` / `finished_at` | Timestamps |
| `is_archived` | `0/1` boolean |
| `archived_at` | Unix timestamp or null |
| `color` | Run color for UI |

### `workflow_sessions`

Session tracking for message logging and permission handling.

| Column | Notes |
| --- | --- |
| `session_id` | Text primary key |
| `task_id` | Associated task |
| `task_run_id` | Associated task run (if any) |
| `session_kind` | `task`, `task_run_worker`, `task_run_reviewer`, `task_run_final_applier`, `review_scratch`, `repair`, `plan`, `plan_revision` |
| `owner_directory` | Project directory |
| `skip_permission_asking` | `0/1` boolean |
| `permission_mode` | Permission handling mode |
| `status` | `active`, `completed`, `deleted`, `stale` |
| `created_at` / `updated_at` | Timestamps |

### `session_messages`

Detailed message logging for timeline reconstruction.

| Column | Notes |
| --- | --- |
| `id` | Integer primary key |
| `message_id` | OpenCode message ID |
| `session_id` | Session reference |
| `task_id` | Task reference (nullable) |
| `task_run_id` | Task run reference (nullable) |
| `timestamp` | Unix timestamp (milliseconds) |
| `role` | `user`, `assistant`, `system`, `tool` |
| `message_type` | `text`, `tool_call`, `tool_result`, `error`, `step_start`, `step_finish`, `session_start`, `session_end`, `session_status`, `thinking`, `user_prompt`, `assistant_response`, `tool_request`, `permission_asked`, `permission_replied`, `session_error`, `message_part` |
| `content_json` | Message content as JSON |
| `model_provider` / `model_id` | Model information |
| `agent_name` | Executing agent |
| `prompt_tokens` / `completion_tokens` / `total_tokens` | Token counts |
| `tool_name` / `tool_args_json` / `tool_result_json` / `tool_status` | Tool execution details |
| `edit_diff` / `edit_file_path` | File edit information |
| `session_status` / `workflow_phase` | Session state |
| `raw_event_json` | Raw bridge event |

## Preferred Write Path

Prefer the HTTP API when the kanban server is running, because API writes also broadcast UI updates.

New task creation appends to the end of the board using `max(idx) + 1`; use the reorder endpoint if the final order matters.

Base URL:

`http://localhost:<port>`

The port is read from `.opencode/easy-workflow/config.json` under the `kanbanPort` key, or from the `options` table as fallback.

Useful endpoints from `src/server.ts`:

### Tasks

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/tasks` | List tasks (excludes archived) |
| `POST` | `/api/tasks` | Create task |
| `PATCH` | `/api/tasks/:id` | Update task (blocked if executing in a run) |
| `DELETE` | `/api/tasks/:id` | Delete task (archives if has history) |
| `PUT` | `/api/tasks/reorder` | Reorder by `idx` |
| `POST` | `/api/tasks/:id/approve-plan` | Approve a plan-mode task |
| `POST` | `/api/tasks/:id/request-plan-revision` | Request plan revision |
| `POST` | `/api/tasks/:id/start` | Start a single task |
| `POST` | `/api/tasks/:id/repair-state` | Repair task state |
| `PATCH` | `/api/tasks/:id/review-limits` | Update review limits |
| `GET` | `/api/tasks/:id/review-status` | Get review status and history |
| `GET` | `/api/tasks/:id/runs` | List best-of-n child runs |
| `GET` | `/api/tasks/:id/candidates` | List best-of-n candidates |
| `GET` | `/api/tasks/:id/best-of-n-summary` | Aggregated best-of-n progress |
| `GET` | `/api/tasks/:id/messages` | Get messages for a task |

### Workflow Runs

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/runs` | List workflow runs |
| `DELETE` | `/api/runs/:id` | Archive a completed/failed run |
| `POST` | `/api/runs/:id/pause` | Pause a running workflow |
| `POST` | `/api/runs/:id/resume` | Resume a paused workflow |
| `POST` | `/api/runs/:id/stop` | Stop a workflow |

### Bulk Operations

| Method | Path | Purpose |
| --- | --- | --- |
| `DELETE` | `/api/tasks/done/all` | Archive/delete all done tasks |

### Options & Configuration

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/options` | Read workflow defaults |
| `PUT` | `/api/options` | Update workflow defaults |
| `GET` | `/api/branches` | List git branches |
| `GET` | `/api/models` | List available models |

### Execution

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/start` | Start workflow execution |
| `POST` | `/api/stop` | Stop workflow execution |
| `GET` | `/api/execution-graph` | Get execution plan graph |

### Session Messages

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/sessions/:id/messages` | Get raw messages for session |
| `GET` | `/api/sessions/:id/timeline` | Get formatted timeline |
| `GET` | `/api/task-runs/:id/messages` | Get messages for task run |
| `GET` | `/api/workflow-session/:id` | Check if session is workflow-owned |

### Bridge Events

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/events/bridge` | Receive events from bridge plugin (internal) |

API payload field names use camelCase.
DB column names use snake_case.

If you must write directly to SQLite (standalone server manages this database):

- `requirements` must be JSON-encoded text.
- boolean fields are stored as `0` or `1`.
- `best_of_n_config` must be JSON-encoded text when strategy is `best_of_n`.
- direct DB writes do not broadcast websocket updates.
- creating via raw SQL means you are responsible for `idx`, timestamps, and field normalization.
- when the server receives a `PATCH` that sets `status = backlog` without an explicit `executionPhase`, it resets `executionPhase` to `not_started` and `awaitingPlanApproval` to `false`.

**Note**: The standalone server must be running for the HTTP API to work. If you see connection errors, the server may need to be started with `bun run start` from the project root.

## Useful Queries

Inspect current tasks:

```sql
SELECT id, idx, name, status, execution_phase, awaiting_plan_approval, requirements
FROM tasks
WHERE is_archived = 0
ORDER BY idx ASC;
```

Inspect only runnable backlog tasks:

```sql
SELECT id, idx, name, branch, status, execution_phase
FROM tasks
WHERE status = 'backlog'
  AND execution_phase != 'plan_complete_waiting_approval'
  AND is_archived = 0
ORDER BY idx ASC;
```

Inspect templates:

```sql
SELECT id, idx, name
FROM tasks
WHERE status = 'template'
  AND is_archived = 0
ORDER BY idx ASC;
```

Inspect workflow defaults:

```sql
SELECT key, value
FROM options
ORDER BY key ASC;
```

Inspect tasks waiting for plan approval:

```sql
SELECT id, idx, name, status, execution_phase, awaiting_plan_approval, plan_revision_count
FROM tasks
WHERE awaiting_plan_approval = 1
  AND is_archived = 0
ORDER BY idx ASC;
```

Inspect archived tasks:

```sql
SELECT id, name, archived_at
FROM tasks
WHERE is_archived = 1
ORDER BY archived_at DESC;
```

Inspect active workflow runs:

```sql
SELECT id, kind, status, display_name, current_task_id, pause_requested, stop_requested
FROM workflow_runs
WHERE is_archived = 0
  AND status IN ('running', 'paused')
ORDER BY created_at DESC;
```

Example direct insert shape:

```sql
INSERT INTO tasks (
  id, name, idx, prompt, branch, plan_model, execution_model,
  planmode, auto_approve_plan, review, auto_commit, delete_worktree, status,
  requirements, created_at, updated_at, thinking_level,
  execution_phase, awaiting_plan_approval, plan_revision_count,
  execution_strategy, best_of_n_substage, skip_permission_asking
) VALUES (
  'task1234',
  'Implement feature X',
  7,
  'Implement feature X according to the user-approved scope...',
  'main',
  'default',
  'default',
  0,
  0,
  1,
  1,
  1,
  'backlog',
  '[]',
  unixepoch(),
  unixepoch(),
  'default',
  'not_started',
  0,
  0,
  'standard',
  'idle',
  1
);
```

## Example API Payloads

Create a normal backlog task:

```json
{
  "name": "Build settings form",
  "prompt": "Implement the settings form described in the user-provided scope. Preserve the existing UI patterns and add only the fields required by the spec.",
  "status": "backlog",
  "branch": "main",
  "planModel": "default",
  "executionModel": "default",
  "planmode": false,
  "autoApprovePlan": false,
  "review": true,
  "autoCommit": true,
  "deleteWorktree": true,
  "skipPermissionAsking": true,
  "requirements": [],
  "thinkingLevel": "default"
}
```

Create a plan-mode task that should pause for approval after planning:

```json
{
  "name": "Design migration strategy",
  "prompt": "Review the source material, produce a migration plan, and stop for approval before implementation.",
  "status": "backlog",
  "planmode": true,
  "autoApprovePlan": false,
  "review": true,
  "autoCommit": true,
  "deleteWorktree": true,
  "skipPermissionAsking": true,
  "requirements": [],
  "thinkingLevel": "medium"
}
```

Create a plan-mode task with auto-approval:

```json
{
  "name": "Refactor utility functions",
  "prompt": "Refactor the utility functions for better testability.",
  "status": "backlog",
  "planmode": true,
  "autoApprovePlan": true,
  "review": true,
  "autoCommit": true,
  "deleteWorktree": true,
  "skipPermissionAsking": true,
  "requirements": [],
  "thinkingLevel": "default"
}
```

Create a best-of-n task:

```json
{
  "name": "Implement API pagination (best-of-n)",
  "prompt": "Add cursor-based pagination to the list endpoint and update tests.",
  "status": "backlog",
  "executionStrategy": "best_of_n",
  "bestOfNConfig": {
    "workers": [
      { "model": "openai-codex/gpt-5.3-codex-spark", "count": 2 },
      { "model": "openai-codex/gpt-5.4-mini", "count": 1, "taskSuffix": "Prefer minimal schema changes." }
    ],
    "reviewers": [
      { "model": "openai-codex/gpt-5.4-mini", "count": 1 }
    ],
    "finalApplier": {
      "model": "openai-codex/gpt-5.3-codex",
      "taskSuffix": "Preserve current API response compatibility."
    },
    "minSuccessfulWorkers": 1,
    "selectionMode": "pick_or_synthesize",
    "verificationCommand": "bun test"
  },
  "planmode": false,
  "review": true,
  "autoCommit": true,
  "deleteWorktree": true,
  "skipPermissionAsking": true,
  "requirements": [],
  "thinkingLevel": "medium"
}
```

Update review limits for a task:

```json
// PATCH /api/tasks/task123/review-limits
{
  "maxReviewRunsOverride": 5,
  "smartRepairHints": "Focus on error handling and edge cases"
}
```

Repair a task with smart repair:

```json
// POST /api/tasks/task123/repair-state
{
  "action": "smart",
  "smartRepairHints": "The issue is likely with the database connection string"
}
```

## Plan-to-Task Heuristics

- If the source describes milestones, map each milestone to one or more executable tasks.
- If the source mixes research, implementation, and validation, split those into separate tasks when they can be reviewed independently.
- If one step exists only to unblock another, make it a dependency.
- If a step is optional, risky, or calls for human approval, consider `planmode = true`.
- If you want fast iteration without approval delays, use `autoApprovePlan = true` with `planmode = true`.
- If the user wants reusable scaffolding for future work, create `template` tasks instead of backlog tasks.
- Keep prompts explicit about files, subsystems, constraints, and verification expectations when those are available in the source.
- Use `maxReviewRunsOverride` when a task is expected to need more review cycles than the default.
- Set `skipPermissionAsking = false` only when the user wants to manually approve file edits.

## Validation Checklist

Before finishing, verify:

- task names are distinct and readable
- prompts are actionable
- dependencies reference real task ids
- no obvious circular dependency exists
- statuses are appropriate for the user's intent
- plan-mode tasks are only used where an approval pause is actually useful
- `autoApprovePlan` is only used when the user trusts automatic plan approval
- `best_of_n` is only used where candidate fan-out/convergence is useful
- `bestOfNConfig` is valid (workers present, counts > 0, final applier model present, min successful workers <= total workers)
- ordering in `idx` matches the intended flow
- tasks won't conflict with active workflow runs (check `/api/runs`)

## What to Tell the User

After setup, report:

- how many tasks you created or updated
- any templates versus backlog tasks
- any important dependencies you added
- any plan-mode tasks with or without auto-approval
- any best-of-n tasks with their worker/reviewer configuration
- any assumptions you made while translating the source material
- any ambiguities that still need user input
