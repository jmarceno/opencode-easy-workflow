# Kanban Best-of-N Execution Plan

## Goal

Implement a new Kanban task execution mode that behaves like a best-of-n workflow:

1. Run multiple worker candidates in parallel, often across different models and repeated slots.
2. Evaluate the successful candidates with one or more reviewer runs.
3. Use a final applier step to either pick the best candidate or synthesize a stronger final patch.
4. Apply the final result through our existing worktree-based merge path instead of editing the live branch directly.

This feature should fit the current Easy Workflow architecture instead of creating a separate orchestration system.

## Summary

The current Kanban system already has most of the primitives needed:

- isolated worktrees per execution
- OpenCode session creation and session URLs
- dependency-aware batching and parallel execution
- automated review loops
- merge/apply behavior back onto the target branch
- a Kanban UI with task cards, options, graph preview, toasts, logs, and mutation guards

What is missing is a way for one logical task to fan out into multiple candidate executions, then converge back into one final applied result.

The recommended design is:

- keep one visible Kanban card per logical task
- add a new `best_of_n` execution strategy on that card
- store child worker/reviewer/applier runs separately from normal tasks
- expose those child runs in a task details modal, not as independent board cards

## Non-Goals

Out of scope for the first implementation:

- showing every worker candidate as a first-class board card
- letting the final applier modify the live branch directly
- combining best-of-n with plan mode in v1
- interactive, manual merge tooling inside the board
- provider-specific tuning beyond the existing model and thinking-level controls

## Why This Shape Fits Our System

The current Kanban board models user intent as one card per task. Best-of-n is still one user task. The worker and reviewer runs are internal execution details, similar to how a task already has hidden sub-steps today:

- create worktree
- create session
- execute prompt
- optionally review
- optionally commit
- merge
- clean up

Best-of-n extends that internal lifecycle but should not overload the board with implementation-detail cards.

## Proposed User Experience

### Task Creation

Add a new field to the task modal:

- `Execution Strategy`
  - `Standard`
  - `Best of N`

When `Best of N` is selected, reveal an advanced configuration section:

- `Workers`
  - rows of `model`, `count`, optional `taskSuffix`
- `Reviewers`
  - rows of `model`, `count`, optional `taskSuffix`
- `Final Applier`
  - `model`
  - optional `taskSuffix`
  - `selectionMode`
- `Minimum Successful Workers`
- optional `Verification Command`

Recommended initial `selectionMode` values:

- `pick_best`
- `synthesize`
- `pick_or_synthesize`

### Board Card UX

Keep one card on the board.

Add new badges and compact status text:

- `best-of-n`
- `workers 3/5`
- `reviewers 2/3`
- `final apply`
- warning badge if partial failures occurred

Add a `View Runs` action to open a detail modal.

### Detail Modal UX

Add a best-of-n execution details modal with tabs:

1. `Overview`
2. `Workers`
3. `Reviewers`
4. `Final Apply`

Each run row should show:

- phase
- slot number
- model
- status
- summary
- session link
- worktree path if preserved
- error message if failed

Worker rows should also show:

- changed files summary
- verification result summary
- reviewer score or recommendation if available later

### Start Flow UX

Before starting execution, the execution graph modal should include additional summary for best-of-n tasks:

- total logical tasks
- total internal runs that will be created
- parallel impact summary
- warning if run count is high

For example:

`1 task, 5 worker runs, 2 reviewer runs, 1 final applier run`

### Review Fallback UX

If workers produce ambiguous results or reviewer consensus is insufficient, the task should move to the existing `Review` column for human action. The operator should see:

- why auto-selection stopped
- which candidates succeeded
- which runs failed
- what the reviewers disagreed about

## Execution Model

### New Task Strategy

Add a task-level field:

```ts
executionStrategy: "standard" | "best_of_n"
```

`standard` preserves current behavior.

`best_of_n` activates the new orchestration path.

### New Best-of-N Config

Add a structured config field on the task:

```ts
interface BestOfNConfig {
  workers: BestOfNSlot[]
  reviewers: BestOfNSlot[]
  finalApplier: BestOfNFinalApplier
  minSuccessfulWorkers: number
  selectionMode: "pick_best" | "synthesize" | "pick_or_synthesize"
  verificationCommand?: string
}

interface BestOfNSlot {
  model: string
  count: number
  taskSuffix?: string
}

interface BestOfNFinalApplier {
  model: string
  taskSuffix?: string
}
```

Notes:

- `model` follows the existing `provider/model` pattern.
- `count` means “run this slot this many times in parallel”.
- `taskSuffix` appends extra slot-specific instructions without replacing the main task prompt.
- `minSuccessfulWorkers` defaults to `1`.

### Task Lifecycle

For `best_of_n`, the logical task lifecycle remains compatible with the current board:

`Backlog -> Executing -> Review or Done`

Internally, the execution sub-stages are:

1. `workers_pending`
2. `workers_running`
3. `reviewers_running`
4. `final_apply_running`
5. `completed`
6. `blocked_for_manual_review`

These sub-stages should be stored explicitly so the UI can show progress without inferring it from child rows.

## Architecture

### High-Level Flow

```text
Kanban Task (best_of_n)
  -> expand worker slots into parallel worker runs
  -> collect successful candidates
  -> run reviewer slots over the candidate set
  -> aggregate reviewer findings
  -> run final applier in fresh worktree
  -> merge final applier result into target branch
  -> mark logical task done
```

### Important Safety Choice

The reference prompt applies directly on the current branch.

We should not do that here.

Instead, the final applier should run in a dedicated temporary worktree and then reuse the existing merge flow in `orchestrator.ts`. This keeps behavior consistent with the current system and reduces risk around concurrent user edits.

## Data Model Changes

## `types.ts`

Add:

```ts
export type ExecutionStrategy = "standard" | "best_of_n"

export type BestOfNSubstage =
  | "idle"
  | "workers_running"
  | "reviewers_running"
  | "final_apply_running"
  | "blocked_for_manual_review"
  | "completed"

export interface BestOfNSlot {
  model: string
  count: number
  taskSuffix?: string
}

export interface BestOfNFinalApplier {
  model: string
  taskSuffix?: string
}

export interface BestOfNConfig {
  workers: BestOfNSlot[]
  reviewers: BestOfNSlot[]
  finalApplier: BestOfNFinalApplier
  minSuccessfulWorkers: number
  selectionMode: "pick_best" | "synthesize" | "pick_or_synthesize"
  verificationCommand?: string
}
```

Extend `Task` with:

```ts
executionStrategy: ExecutionStrategy
bestOfNConfig: BestOfNConfig | null
bestOfNSubstage: BestOfNSubstage
```

## SQLite Schema

Keep the existing `tasks` table and add a few columns:

- `execution_strategy TEXT NOT NULL DEFAULT 'standard'`
- `best_of_n_config TEXT`
- `best_of_n_substage TEXT NOT NULL DEFAULT 'idle'`

Add a new table for child runs:

```sql
CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  phase TEXT NOT NULL,                    -- worker|reviewer|final_applier
  slot_index INTEGER NOT NULL DEFAULT 0,
  attempt_index INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL,
  task_suffix TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|failed|skipped
  session_id TEXT,
  session_url TEXT,
  worktree_dir TEXT,
  summary TEXT,
  error_message TEXT,
  candidate_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER,
  FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_runs_task_id ON task_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_phase ON task_runs(phase);
CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status);
```

Add a new table for successful worker outputs:

```sql
CREATE TABLE IF NOT EXISTS task_candidates (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  worker_run_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available',
  changed_files_json TEXT NOT NULL DEFAULT '[]',
  diff_stats_json TEXT NOT NULL DEFAULT '{}',
  verification_json TEXT NOT NULL DEFAULT '{}',
  summary TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY(worker_run_id) REFERENCES task_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_candidates_task_id ON task_candidates(task_id);
```

### Why Separate Tables

Do not store worker and reviewer state as one JSON blob on the task record.

Separate tables are better because:

- runs are concurrent
- each run has independent sessions and errors
- the UI needs to filter and refresh them independently
- retries and analytics are easier later
- persistence is more robust across restarts

## API Changes

### Task CRUD

Extend existing task payloads to include:

- `executionStrategy`
- `bestOfNConfig`
- `bestOfNSubstage` in read responses only

Validation rules:

- `executionStrategy` must be `standard` or `best_of_n`
- when `standard`, `bestOfNConfig` must be `null` or omitted
- when `best_of_n`, config must be present and valid
- total expanded worker count must stay below a server-enforced limit
- total reviewer count must stay below a server-enforced limit
- final applier model must be present
- `minSuccessfulWorkers` must be between `1` and expanded worker count

### New Read Endpoints

Add:

- `GET /api/tasks/:id/runs`
- `GET /api/tasks/:id/candidates`

`GET /api/tasks/:id/runs` returns all child runs for the task.

`GET /api/tasks/:id/candidates` returns successful worker candidate summaries.

### Optional Summary Endpoint

If UI payload size becomes a problem, add:

- `GET /api/tasks/:id/best-of-n-summary`

This endpoint would aggregate the current counts and statuses for fast modal rendering.

### Execution Graph Endpoint

Extend `GET /api/execution-graph` so best-of-n tasks report internal expansion metadata in addition to the existing dependency batches.

The graph still treats each logical task as a single node in dependency planning, but adds metadata such as:

- `expandedWorkerRuns`
- `expandedReviewerRuns`
- `hasFinalApplier`
- `estimatedRunCount`

## WebSocket Changes

Add new message types:

- `task_run_created`
- `task_run_updated`
- `task_candidate_created`
- `task_candidate_updated`

The main task card should continue using `task_updated` for top-level lifecycle changes. Child-run messages should update the details modal and compact card summaries.

## Orchestrator Changes

## Current Reuse Points

The best-of-n path should reuse existing logic where possible:

- model resolution
- worktree creation and cleanup
- session creation and session URLs
- execution failure extraction
- merge target branch resolution
- final merge behavior

## New Orchestrator Branch

In `executeTask(task, options)`:

- if `executionStrategy === "standard"`, preserve current behavior
- if `executionStrategy === "best_of_n"`, call a dedicated method such as `executeBestOfNTask(task, options)`

## Worker Phase

### Expansion

Expand configured worker slots into concrete runs.

Example:

```yaml
workers:
  - model: openai-codex/gpt-5.3-codex-spark:low
    count: 3
  - model: openai-codex/gpt-5.4-mini:high
    count: 2
```

becomes 5 concrete worker runs.

Each run receives:

- the original task prompt
- any slot-specific `taskSuffix`
- its configured model
- a fresh worktree
- a fresh session

### Prompt Shape

Worker runs should receive the normal task prompt plus a short, deterministic prefix describing the role.

Example shape:

```text
You are one candidate implementation worker in a best-of-n workflow.
Produce the best complete solution you can in this worktree.

Task:
<original prompt>

Additional instructions for this worker:
<taskSuffix if present>
```

### Capturing Candidate Output

For each successful worker run, capture:

- session metadata
- textual output summary
- changed files list
- diff stats
- optional verification result

These become a `task_candidate` record.

### Failure Semantics

- failed workers do not immediately fail the logical task
- if `successfulWorkers < minSuccessfulWorkers`, the task fails
- if `successfulWorkers >= minSuccessfulWorkers`, continue with warnings

## Reviewer Phase

### Inputs

Reviewers should inspect:

- original task prompt
- summaries from all successful candidates
- candidate diffs or changed-file summaries
- optional verification outputs

### Reviewer Prompt Shape

Each reviewer should answer a structured format, for example:

```text
STATUS: pass | needs_manual_review
SUMMARY: <short summary>
BEST_CANDIDATES:
- candidate-id-1
- candidate-id-2
GAPS:
- issue 1
- issue 2
RECOMMENDED_FINAL_STRATEGY: pick_best | synthesize
RECOMMENDED_PROMPT:
<optional instructions for final applier>
```

### Aggregation

Aggregate reviewer outputs into one internal summary:

- candidate vote counts
- recurring risks
- recurring gaps
- consensus or lack of consensus
- recommended final strategy

### Reviewer Failure Semantics

- partial reviewer failure is acceptable if at least one usable reviewer result exists
- if no usable reviewer result exists, move the task to `Review`
- if reviewers strongly disagree and no clear winner exists, move the task to `Review` unless `selectionMode` explicitly allows synthesis without consensus

## Final Applier Phase

### Input Material

The final applier should run in a fresh worktree with:

- original task prompt
- all successful candidate summaries
- reviewer consensus summary
- selected `selectionMode`
- any recommended prompt from reviewers

### Behavior

The final applier should either:

1. pick the strongest candidate and recreate or apply that solution in its worktree
2. synthesize a stronger final solution that combines the best parts of multiple candidates

It should then:

- run best-effort verification
- report changed files and verification outcome

### Apply Strategy

Do not cherry-pick worker candidates directly into the live branch.

Use the final applier worktree as the only source of truth for the final merge. This avoids trying to merge multiple competing candidate branches.

### Completion

After final applier success:

- reuse existing merge behavior
- clean up worktree if configured
- mark the logical task `done`

## Error Handling

## Save-Time Validation

The UI and API should reject invalid configs early:

- empty workers list
- zero or negative counts
- invalid selection mode
- missing final applier model
- `minSuccessfulWorkers` greater than total worker count
- total expanded run count above limit

## Start-Time Validation

Revalidate before execution starts:

- server URL available
- models still resolve against live provider catalog
- execution is not already running
- task is not in an incompatible state

## Runtime Failure Handling

### Worker Failures

- store failure on the child run
- keep logical task executing unless success threshold becomes impossible
- show warning on task card

### Reviewer Failures

- store failure on the child run
- continue if there are enough reviewer results to make a decision
- otherwise route to manual review

### Final Applier Failures

- fail the logical task or route to review depending on failure type
- preserve all worker and reviewer artifacts for inspection

Recommended rule:

- infrastructure or provider failures -> `failed`
- ambiguous decision or insufficient consensus -> `review`

### Worktree Cleanup Failures

- log warning
- keep task outcome accurate
- preserve worktree path on affected run so the operator can inspect it later

### Restart / Crash Recovery

On startup, repair impossible intermediate states similarly to the current plan-approval repair logic.

Examples:

- task marked `executing` with all child runs terminal and no final result -> move to `failed`
- task in `final_apply_running` with missing final applier run -> move to `failed`
- task in `reviewers_running` with zero successful workers -> move to `failed`

## UX and Safety Rules

### Limits

Set hard limits in v1 to prevent accidental explosion:

- max expanded worker runs: 8
- max expanded reviewer runs: 4
- max total internal runs per task: 12 or similar

### Compatibility Restrictions

Disallow in v1:

- `planmode + best_of_n`
- auto-review loop on top of best-of-n reviewer phase unless explicitly designed

Recommendation for v1:

- `review` on a best-of-n task means the task can still land in the existing `Review` column for human action
- do not stack the current review loop after final apply for the first release

This keeps the first version understandable.

### Mutation Guards

Keep the existing behavior:

- task mutation blocked while execution is running
- best-of-n child records are read-only during execution

### Operator Clarity

The card and modal should always answer:

- how many workers were planned
- how many succeeded
- whether reviewers agreed
- what the final applier is doing now
- whether manual review is required

## UI Implementation Plan

## Task Modal

Add fields:

- `Execution Strategy`
- dynamic `Best of N Configuration` section

Use the existing model dropdown behavior for each configured slot.

Recommended initial UI pattern:

- editable rows for workers and reviewers
- add/remove row buttons
- `count` numeric input
- model dropdown
- optional suffix textarea

### Validation UX

Show inline validation errors before save instead of relying only on toasts.

Examples:

- `Add at least one worker slot`
- `Final applier model is required`
- `Minimum successful workers cannot exceed total workers`

## Card Rendering

Extend `renderCard()` to show:

- `best-of-n` badge
- substage badge
- summary counts
- `View Runs` button

Do not dump all candidate summaries directly into the card body.

## Detail Modal

Add a modal dedicated to best-of-n details.

It should load child records from new endpoints and subscribe to new WebSocket messages.

The modal should support:

- live updates while execution is running
- opening run sessions in OpenCode
- copying candidate summaries if needed
- highlighting the recommended or selected final candidate

## Server Implementation Plan

In `server.ts`:

1. validate and persist new task fields
2. expose child run and candidate endpoints
3. extend graph preview payload
4. broadcast new child-run websocket events
5. return actionable 400 errors for invalid best-of-n configs

Recommended helper functions:

- `isExecutionStrategy()`
- `validateBestOfNConfig()`
- `normalizeBestOfNConfig()`

## Database Layer Plan

In `db.ts`:

1. migrate `tasks` for new columns
2. create `task_runs` and `task_candidates`
3. add CRUD helpers:
   - `createTaskRun()`
   - `updateTaskRun()`
   - `getTaskRuns(taskId)`
   - `createTaskCandidate()`
   - `updateTaskCandidate()`
   - `getTaskCandidates(taskId)`
   - `deleteTaskRunsForTask(taskId)` if needed
4. ensure task deletion cascades cleanly

## Orchestrator Implementation Plan

Recommended new methods in `orchestrator.ts`:

- `executeBestOfNTask(task, options)`
- `expandBestOfNWorkers(config)`
- `runBestOfNWorker(task, workerRun, options)`
- `collectCandidateArtifacts(...)`
- `runBestOfNReviewer(task, reviewerRun, candidates, options)`
- `aggregateReviewerResults(reviewerOutputs)`
- `runBestOfNFinalApplier(task, summary, options)`

Keep existing helper reuse high and avoid duplicating:

- session URL construction
- model validation
- failure extraction
- merge target resolution
- worktree cleanup logic

## Recommended V1 Decisions

To keep scope controlled:

1. reuse existing task-level branch, thinking level, and delete-worktree settings
2. allow per-slot model override, but not per-slot thinking-level override yet
3. disable plan mode for best-of-n tasks
4. do not run the legacy review loop after final applier in v1
5. route ambiguity to manual review instead of forcing automation

## Testing Plan

## Automated Tests

Add new tests covering:

1. task create/update validation for `best_of_n`
2. DB migration for new task fields and child tables
3. worker expansion logic
4. worker partial failure with threshold success
5. all workers failed -> task failed
6. reviewer aggregation with partial reviewer failures
7. no usable reviewer results -> task moved to `Review`
8. final applier success -> merged and task done
9. final applier failure -> task failed or review depending on reason
10. child run websocket updates reflected in UI state
11. graph preview includes internal run counts
12. restart repair for invalid intermediate best-of-n states

### UI Tests

Extend the web UI tests to verify:

1. task modal shows execution strategy selector
2. best-of-n controls appear when selected
3. invalid config blocks save
4. saved config reloads correctly
5. card shows best-of-n progress summary
6. run details modal loads child runs from API

## Manual Smoke Checks

1. create a simple best-of-n task with 2 workers, 1 reviewer, 1 applier
2. confirm worker sessions are isolated and visible
3. confirm one worker failure does not halt if threshold is met
4. confirm reviewer results are shown in the modal
5. confirm final applier result merges into the target branch
6. confirm ambiguous reviewer outputs route the card to `Review`

## Rollout Plan

1. types and DB migrations
2. task API validation and persistence
3. child run tables and APIs
4. orchestrator worker fan-out
5. reviewer aggregation
6. final applier integration
7. UI task modal and card badges
8. details modal and live updates
9. tests and crash-state repair

## Risks and Mitigations

### Risk: runaway cost from too many internal runs

Mitigation:

- hard run limits
- start-time warnings in UI
- simple defaults

### Risk: ambiguous reviewer results

Mitigation:

- route to manual review instead of over-automating
- preserve candidate artifacts and summaries

### Risk: stale or invalid model config

Mitigation:

- validate on save and again on start
- use existing model resolver at execution time

### Risk: too much UI complexity on cards

Mitigation:

- keep details in a modal
- keep board-level summary compact

### Risk: interaction with existing review and plan flows becomes confusing

Mitigation:

- explicitly restrict unsupported combinations in v1
- preserve current behavior for `standard` tasks untouched

## Acceptance Criteria

- a task can opt into `best_of_n` execution strategy
- one logical task can fan out into multiple isolated worker runs
- successful worker results are persisted as candidate artifacts
- reviewer runs can inspect candidate sets and produce structured guidance
- a final applier can pick or synthesize a final patch in a fresh worktree
- the final result merges through the existing safe merge path
- the board remains one-card-per-logical-task
- the UI surfaces internal run progress without flooding the board
- partial failures are visible and handled without losing artifacts
- ambiguous outcomes route to the existing `Review` column
- invalid or impossible states are repaired or failed explicitly after restart

## Recommended File Touch Points

- `.opencode/easy-workflow/types.ts`
- `.opencode/easy-workflow/db.ts`
- `.opencode/easy-workflow/server.ts`
- `.opencode/easy-workflow/orchestrator.ts`
- `.opencode/easy-workflow/execution-plan.ts`
- `.opencode/easy-workflow/kanban/index.html`
- `tests/test-kanban-web-ui.ts`
- new test files for best-of-n orchestration and validation
