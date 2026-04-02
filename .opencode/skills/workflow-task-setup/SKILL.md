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

## Recommended Workflow

1. Read the source material and extract the real deliverables, constraints, and acceptance criteria.
2. Check existing tasks before creating new ones.
3. Split the work into the smallest useful execution units.
4. Decide whether each item should be a `template` or `backlog` task.
5. Add dependencies only where one task truly blocks another.
6. Create tasks in intended execution order, or reorder them afterward.
7. Verify the stored result by listing tasks again and summarizing the mapping back to the user.

## Task Shape

The workflow task model is defined in `.opencode/easy-workflow/types.ts`.

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
| `executionStrategy` | Execution mode (`standard` or `best_of_n`) | `standard` |
| `bestOfNConfig` | Best-of-N worker/reviewer/final-applier config | `null` unless strategy is `best_of_n` |
| `review` | Run review loop after implementation | `true` |
| `autoCommit` | Auto-commit on success | `true` |
| `deleteWorktree` | Remove worktree after completion | `true` |
| `requirements` | Array of blocking task ids | `[]` |
| `thinkingLevel` | Reasoning effort | `default` |

Advanced fields normally left alone on fresh task creation:

| Field | Meaning |
| --- | --- |
| `executionPhase` | Internal phase for plan-mode lifecycle |
| `bestOfNSubstage` | Internal substage for best-of-n lifecycle |
| `awaitingPlanApproval` | Whether a plan-mode task is waiting for approval |
| `agentOutput` | Accumulated agent output |
| `reviewCount` | Review loop counter |
| `sessionId` / `sessionUrl` | Linked OpenCode session |
| `worktreeDir` | Active worktree location |
| `errorMessage` | Failure detail |
| `completedAt` | Unix timestamp when done |

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
| `plan_complete_waiting_approval` | Planning finished and the task is paused |
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
- Resetting a task to backlog clears it back to `executionPhase = not_started` and `awaitingPlanApproval = false`.
- Best-of-N and plan mode cannot be combined in v1 (`planmode = true` with `executionStrategy = best_of_n` is rejected by API validation).
- For `best_of_n`, the board still treats it as one logical task card while child runs are stored separately.
- `failed` and `stuck` appear in the review column in the UI, but they are distinct stored statuses.

## Dependency Rules

- Dependencies are stored as task ids in `requirements`.
- The DB stores `requirements` as a JSON string, but the API uses a JSON array of strings.
- Only add a dependency when task B should not begin until task A is completed.
- Avoid artificial chains when tasks can be reviewed and executed independently.
- Circular dependencies will break scheduling.
- Tasks that are already outside the current executable set do not block batching the same way as active backlog items, so dependencies are most meaningful between active tasks you are setting up.

## Persistence Layout

The workflow DB is initialized by the plugin in:

`<workspace>/.opencode/easy-workflow/tasks.db`

The storage layer lives in `.opencode/easy-workflow/db.ts`.

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
| `review` | `0/1` boolean |
| `auto_commit` | `0/1` boolean |
| `delete_worktree` | `0/1` boolean |
| `status` | Task status string |
| `requirements` | JSON array string of task ids |
| `agent_output` | Aggregated output |
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
| `execution_strategy` | `standard` or `best_of_n` |
| `best_of_n_config` | JSON config for worker/reviewer/final-applier runs |
| `best_of_n_substage` | Internal best-of-n substage |

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
| `command` | Pre-execution command |
| `parallel_tasks` | Parallelism limit |
| `port` | Kanban server port |
| `thinking_level` | Default thinking level |

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
| `worktree_dir` | Worktree path (kept if cleanup fails or disabled) |
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

## Preferred Write Path

Prefer the HTTP API when the kanban server is running, because API writes also broadcast UI updates.

New task creation appends to the end of the board using `max(idx) + 1`; use the reorder endpoint if the final order matters.

Base URL:

`http://localhost:<port>`

The port is stored in the `options` table.

Useful endpoints from `.opencode/easy-workflow/server.ts`:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/tasks` | List tasks |
| `POST` | `/api/tasks` | Create task |
| `PATCH` | `/api/tasks/:id` | Update task |
| `DELETE` | `/api/tasks/:id` | Delete task |
| `PUT` | `/api/tasks/reorder` | Reorder by `idx` |
| `POST` | `/api/tasks/:id/approve-plan` | Approve a plan-mode task |
| `GET` | `/api/options` | Read workflow defaults |
| `PUT` | `/api/options` | Update workflow defaults |
| `GET` | `/api/branches` | List git branches |
| `GET` | `/api/tasks/:id/runs` | List best-of-n child runs for task |
| `GET` | `/api/tasks/:id/candidates` | List best-of-n candidate artifacts |
| `GET` | `/api/tasks/:id/best-of-n-summary` | Aggregated best-of-n progress/status |

API payload field names use camelCase.
DB column names use snake_case.

If you must write directly to SQLite, remember:

- `requirements` must be JSON-encoded text.
- boolean fields are stored as `0` or `1`.
- `best_of_n_config` must be JSON-encoded text when strategy is `best_of_n`.
- direct DB writes do not broadcast websocket updates.
- creating via raw SQL means you are responsible for `idx`, timestamps, and field normalization.
- when the server receives a `PATCH` that sets `status = backlog` without an explicit `executionPhase`, it resets `executionPhase` to `not_started` and `awaitingPlanApproval` to `false`.

## Useful Queries

Inspect current tasks:

```sql
SELECT id, idx, name, status, execution_phase, awaiting_plan_approval, requirements
FROM tasks
ORDER BY idx ASC;
```

Inspect only runnable backlog tasks:

```sql
SELECT id, idx, name, branch, status, execution_phase
FROM tasks
WHERE status = 'backlog'
  AND execution_phase != 'plan_complete_waiting_approval'
ORDER BY idx ASC;
```

Inspect templates:

```sql
SELECT id, idx, name
FROM tasks
WHERE status = 'template'
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
SELECT id, idx, name, status, execution_phase, awaiting_plan_approval
FROM tasks
WHERE awaiting_plan_approval = 1
ORDER BY idx ASC;
```

Example direct insert shape:

```sql
INSERT INTO tasks (
  id, name, idx, prompt, branch, plan_model, execution_model,
  planmode, review, auto_commit, delete_worktree, status,
  requirements, created_at, updated_at, thinking_level,
  execution_phase, awaiting_plan_approval
) VALUES (
  'task1234',
  'Implement feature X',
  7,
  'Implement feature X according to the user-approved scope...',
  'main',
  'default',
  'default',
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
  0
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
  "review": true,
  "autoCommit": true,
  "deleteWorktree": true,
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
  "review": true,
  "autoCommit": true,
  "deleteWorktree": true,
  "requirements": [],
  "thinkingLevel": "medium"
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
  "requirements": [],
  "thinkingLevel": "medium"
}
```

## Plan-to-Task Heuristics

- If the source describes milestones, map each milestone to one or more executable tasks.
- If the source mixes research, implementation, and validation, split those into separate tasks when they can be reviewed independently.
- If one step exists only to unblock another, make it a dependency.
- If a step is optional, risky, or calls for human approval, consider `planmode = true`.
- If the user wants reusable scaffolding for future work, create `template` tasks instead of backlog tasks.
- Keep prompts explicit about files, subsystems, constraints, and verification expectations when those are available in the source.

## Validation Checklist

Before finishing, verify:

- task names are distinct and readable
- prompts are actionable
- dependencies reference real task ids
- no obvious circular dependency exists
- statuses are appropriate for the user's intent
- plan-mode tasks are only used where an approval pause is actually useful
- `best_of_n` is only used where candidate fan-out/convergence is useful
- `bestOfNConfig` is valid (workers present, counts > 0, final applier model present, min successful workers <= total workers)
- ordering in `idx` matches the intended flow

## What to Tell the User

After setup, report:

- how many tasks you created or updated
- any templates versus backlog tasks
- any important dependencies you added
- any assumptions you made while translating the source material
- any ambiguities that still need user input
