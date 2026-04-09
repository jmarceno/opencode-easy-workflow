---
name: task-debug
description: Diagnose and repair failed, stuck, or misbehaving Easy Workflow tasks using session logs, timelines, worktree state, and deterministic repair logic.
compatibility: opencode
metadata:
  audience: agents
  workflow: easy-workflow
---

## What I do

- Diagnose why a task is `failed`, `stuck`, or otherwise not progressing.
- Reconstruct what an agent actually did by examining the session timeline.
- Compare task output against worktree changes to verify implementation completeness.
- Apply the correct repair action (`reset_backlog`, `queue_implementation`, `mark_done`, `fail_task`, `restore_plan_approval`) based on evidence.
- Identify when to escalate to human review versus auto-repair.

## When to use me

- A task is `failed` or `stuck` and you need to understand why.
- A task has `errorMessage` set and you need to investigate.
- An agent session ended unexpectedly or produced no useful output.
- A best-of-n task has failed worker/reviewer runs and you need to assess the damage.
- The workflow is not progressing and you need to diagnose the bottleneck.
- You want to verify that a completed task actually made the promised changes.

## Core Behavior

- **Always investigate before acting.** Reading logs and timelines is faster than trial-and-error repair.
- **Cross-reference evidence.** A task's `agentOutput` alone is insufficient—check the worktree git status and session timeline.
- **Prefer `reset_backlog` when evidence is ambiguous.** Starting fresh is often more productive than patching a broken state.
- **Use `mark_done` only when worktree AND output both confirm completion.** An empty worktree with a "done" plan is NOT done.
- **Preserve history.** Before resetting or repairing, note what happened so the next repair attempt has context.

## Investigation Workflow

### Step 1: Gather Task State

Start by fetching the task and understanding its current state:

```bash
# Get task details
curl http://localhost:<port>/api/tasks/<task-id>

# Get task runs (for best-of-n)
curl http://localhost:<port>/api/tasks/<task-id>/runs

# Get task candidates (for best-of-n)
curl http://localhost:<port>/api/tasks/<task-id>/candidates
```

Key fields to examine:

| Field | What it tells you |
| --- | --- |
| `status` | Current board state (`failed`, `stuck`, `review`, `executing`, etc.) |
| `errorMessage` | If set, the workflow recorded a failure reason |
| `agentOutput` | Accumulated tagged output (`[plan]`, `[exec]`, `[review-fix-N]`) |
| `sessionId` / `sessionUrl` | OpenCode session link—use for timeline |
| `worktreeDir` | Worktree path—check git status there |
| `executionPhase` | Internal phase for plan-mode tasks |
| `reviewCount` | How many review cycles ran |
| `bestOfNSubstage` | For best-of-n: which phase is active |

### Step 2: Examine Session Timeline

The session timeline gives you the full message log in chronological order:

```bash
# Get formatted timeline with summaries
curl http://localhost:<port>/api/sessions/<session-id>/timeline

# Get raw messages (full content)
curl http://localhost:<port>/api/sessions/<session-id>/messages

# Get all messages for a task (across all its sessions)
curl http://localhost:<port>/api/tasks/<task-id>/messages

# Get messages for a specific task run
curl http://localhost:<port>/api/task-runs/<run-id>/messages
```

Timeline entry fields:

| Field | What it tells you |
| --- | --- |
| `role` | `user`, `assistant`, `system`, `tool` |
| `messageType` | `text`, `tool_call`, `tool_result`, `step_finish`, `error` |
| `summary` | Short human-readable description |
| `hasToolCalls` | Whether the message triggered tools |
| `hasEdits` | Whether file edits occurred |
| `modelProvider` / `modelId` | Which model was used |
| `relativeTime` | Milliseconds from session start |

### Step 3: Check Worktree Git State

The worktree tells you what actually changed on disk:

```bash
# In the worktree directory
cd <worktree-dir>
git status --porcelain
git diff --stat
git log --oneline -5
```

**Interpretation:**

| Worktree state | Likely meaning |
| --- | --- |
| Clean (no changes) | Agent made no commits or the worktree was deleted |
| Uncommitted changes | Agent worked but didn't commit |
| Committed changes | Agent completed work in worktree |
| Mixed (some files) | Partial implementation |

### Step 4: Compare Output vs. Worktree

A task is truly complete only when:
1. `agentOutput` contains a `[plan]` block (if planmode) or `[exec]` block
2. The worktree has real file changes matching the promised work
3. For best-of-n: at least one candidate exists with `status: "available"`

**Red flags:**
- `agentOutput` is empty but task is `executing`—session likely crashed
- Worktree is clean but `agentOutput` shows a plan—agent never started implementation
- `errorMessage` says "no captured [plan] block"—plan mode task never produced a plan
- Review cycles keep finding the same gaps—implementation is not converging

### Step 5: Understand Repair Actions

Use `PUT /api/tasks/<task-id>/repair-state` with an `action` field:

```bash
# Manual repair action
curl -X POST http://localhost:<port>/api/tasks/<task-id>/repair-state \
  -H "Content-Type: application/json" \
  -d '{"action": "reset_backlog"}'
```

Available actions:

| Action | When to use |
| --- | --- |
| `reset_backlog` | Task did nothing useful, or state is too corrupted to repair. Start fresh. |
| `queue_implementation` | Task has a valid `[plan]` AND the worktree shows real changes. Resume from implementation. |
| `mark_done` | Worktree AND output both confirm complete work. Close the task. |
| `fail_task` | State is invalid and should stay visible with an error. Use when task cannot be repaired. |
| `restore_plan_approval` | Task should return to plan approval review. |
| `continue_with_more_reviews` | Stuck in review due to limit; allow more review cycles. |
| `smart` | Let the repair model analyze the situation and decide. Requires `repairModel` to be configured. |

## Smart Repair

The server has built-in smart repair that analyzes the full context:

```bash
curl -X POST http://localhost:<port>/api/tasks/<task-id>/repair-state \
  -H "Content-Type: application/json" \
  -d '{"action": "smart"}'
```

Smart repair gathers:
- Worktree git status and diff
- OpenCode session messages (last 5)
- Workflow session history
- Task runs (best-of-n)
- Latest `[plan]`, `[exec]`, and `[user-revision-request]` blocks from `agentOutput`

It then prompts the configured `repairModel` to decide the best action.

## Common Failure Patterns

### Pattern 1: Task crashed with no output

**Symptoms:** `status: "executing"`, `agentOutput: ""`, `sessionId` present but session is gone.

**Diagnosis:** Check session timeline for the last message. Look for `tool_status: "error"` or abrupt truncation.

**Repair:** `reset_backlog`

### Pattern 2: Plan mode task never produced a plan

**Symptoms:** `executionPhase: "plan_complete_waiting_approval"`, `errorMessage` mentions missing `[plan]` block.

**Diagnosis:** Agent either crashed during planning or the plan wasn't captured due to output truncation.

**Repair:** `reset_backlog` (to re-run planning) or `fail_task` (if planning keeps failing)

### Pattern 3: Worktree is clean but task shows output

**Symptoms:** `agentOutput` has `[exec]` block, but `git status` in worktree is clean.

**Diagnosis:** Agent described work but didn't actually edit files, OR worktree was deleted.

**Repair:** `reset_backlog` to re-run implementation, or investigate if worktree cleanup failed.

### Pattern 4: Best-of-n workers all failed

**Symptoms:** `bestOfNSubstage: "workers_running"`, all `task_runs` have `status: "failed"`.

**Diagnosis:** Check `errorMessage` on each failed run. Common causes: compilation errors, test failures, permission issues.

**Repair:** Fix underlying issue, then `reset_backlog` or use `continue_with_more_reviews` if the issue is review-related.

### Pattern 5: Review keeps finding the same gaps

**Symptoms:** `reviewCount` keeps incrementing, same `gaps` appear in each `[review-fix-N]` block.

**Diagnosis:** Implementation is not converging. Agent keeps making the same mistakes.

**Repair options:**
- `continue_with_more_reviews` to allow more cycles
- `reset_backlog` with improved instructions
- Add `smartRepairHints` to give the agent targeted guidance

## Debugging Best-of-N Tasks

For best-of-n tasks, you can drill into individual runs:

```bash
# Get all worker runs
curl http://localhost:<port>/api/tasks/<task-id>/runs

# Get candidates (successful worker outputs)
curl http://localhost:<port>/api/tasks/<task-id>/candidates

# Get best-of-n summary
curl http://localhost:<port>/api/tasks/<task-id>/best-of-n-summary
```

Best-of-n substages:

| Substage | Meaning |
| --- | --- |
| `idle` | Not yet started or completed |
| `workers_running` | Worker candidates are being generated |
| `reviewers_running` | Reviewers are evaluating candidates |
| `final_apply_running` | Final applier is preparing merge result |
| `blocked_for_manual_review` | Waiting for human decision |
| `completed` | Successfully completed |

## State Transitions

Understanding how tasks move between states helps you diagnose issues:

```
backlog → executing (when picked up by orchestrator)
executing → review (after implementation, before approval)
executing → done (autoCommit + successful exec without review)
executing → failed (unrecoverable error)
review → backlog (plan approved or revision requested)
review → done (review passed, no more reviews needed)
review → stuck (review found unresolved gaps)
stuck → backlog (via repair)
failed → backlog (via repair)
```

The orchestrator handles transitions automatically, but stuck/failed states indicate something went wrong that it couldn't resolve.

## Architecture Overview

The debug skill operates on the **standalone server + bridge plugin** architecture:

1. **Standalone Server** (`.opencode/easy-workflow/standalone.ts`)
   - HTTP API on `kanbanPort`
   - SQLite database at `.opencode/easy-workflow/tasks.db`
   - Message logger captures all session events

2. **Bridge Plugin** (in OpenCode plugins directory)
   - Forwards `message.updated`, `tool.execute.after`, `session.updated` events
   - Session IDs link messages to tasks

3. **Database Tables:**

   `tasks` — Core task state

   `task_runs` — Child runs for best-of-n

   `task_candidates` — Successful worker artifacts

   `workflow_sessions` — Links OpenCode sessions to tasks

   `session_messages` — Every message exchanged, with tool calls, diffs, and token usage

## Persistence Layout

Database location: `<workspace>/.opencode/easy-workflow/tasks.db`

The storage layer is in `.opencode/easy-workflow/db.ts`.

Session logs are stored in `session_messages` table and available via:
- `GET /api/sessions/:sessionId/timeline`
- `GET /api/sessions/:sessionId/messages`
- `GET /api/tasks/:taskId/messages`
- `GET /api/task-runs/:runId/messages`

## Diagnostic Checklist

When debugging a failing task, verify:

- [ ] Task `status` and `errorMessage` are set correctly
- [ ] `sessionId` points to a real OpenCode session
- [ ] Session timeline shows what the agent was doing when it stopped
- [ ] Worktree exists and has the expected changes (or lack thereof)
- [ ] `agentOutput` contains the expected tagged blocks (`[plan]`, `[exec]`)
- [ ] For best-of-n: task runs and candidates reflect expected progress
- [ ] `executionPhase` and `awaitingPlanApproval` are consistent with the task type
- [ ] Review gaps (if any) are specific and actionable

## What to Tell the User

After diagnosing a task issue, report:

- What the evidence shows (what the agent did, what the worktree contains)
- Why the current state is incorrect
- What repair action you took (or recommended)
- Any assumptions made during diagnosis
- What the user should expect after the repair (e.g., "task will restart from planning")
