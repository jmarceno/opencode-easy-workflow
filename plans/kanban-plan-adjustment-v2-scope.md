# Kanban Plan Adjustment V2 — Detailed Implementation Plan

## Purpose

Allow users to send change requests to the planning agent from the Kanban UI, triggering a revised plan. The task remains in the approval workflow until the user finally approves. Multiple rounds of revision are supported. A clear audit trail of feedback and revisions is preserved in task output.

---

## 1. Data Model Changes — `.opencode/easy-workflow/types.ts`

### 1.1 Extend `ExecutionPhase` type

**Current union:**
```ts
export type ExecutionPhase = "not_started" | "plan_complete_waiting_approval" | "implementation_pending" | "implementation_done"
```

**New union:**
```ts
export type ExecutionPhase =
  | "not_started"
  | "plan_complete_waiting_approval"
  | "plan_revision_pending"
  | "implementation_pending"
  | "implementation_done"
```

### 1.2 Add `planRevisionCount` field to `Task`

Add to the `Task` interface:
```ts
planRevisionCount: number
```

### 1.3 Add `WSMessageType` for revision event

Append to `WSMessageType` union:
```ts
| "plan_revision_requested"
```

---

## 2. Database Layer — `.opencode/easy-workflow/db.ts`

### 2.1 Schema migration

Add column `plan_revision_count` to `tasks` table:

```ts
// In migrate(), after existing migrations:
const hasPlanRevisionCount = tableInfo.some((col: any) => col.name === "plan_revision_count")
if (!hasPlanRevisionCount) {
  this.db.exec("ALTER TABLE tasks ADD COLUMN plan_revision_count INTEGER NOT NULL DEFAULT 0")
}
```

Also add to the `CREATE TABLE IF NOT EXISTS tasks` DDL so fresh installs get it:
```
plan_revision_count INTEGER NOT NULL DEFAULT 0
```

### 2.2 Update `rowToTask()`

Add field mapping:
```ts
planRevisionCount: row.plan_revision_count ?? 0,
```

### 2.3 Update `normalizeExecutionPhase()`

Add `"plan_revision_pending"` to the valid phases array.

### 2.4 Update `createTask()`

Accept `planRevisionCount` in the data parameter (default `0`). Add to the INSERT statement.

### 2.5 Update `updateTask()`

Accept `planRevisionCount` in the updates type. Add the SQL set clause.

### 2.6 Update `resetTasksForBacklog()`

In the UPDATE statement, also reset `plan_revision_count = 0`.

---

## 3. Server — `.opencode/easy-workflow/server.ts`

### 3.1 New endpoint: `POST /api/tasks/:id/request-plan-revision`

**Location:** Insert after the `approve-plan` handler (after line ~552).

**URL pattern:**
```
POST /api/tasks/:id/request-plan-revision
```

**Request body:**
```ts
{ feedback: string }
```

**Validation sequence (mirrors approve-plan guards):**

1. Task must exist → 404
2. Execution must not be running (`getExecuting()`) → 409
3. Task must have plan output (`task.agentOutput.trim()`) → 400
4. Task must be in `review` status and `awaitingPlanApproval === true` → 400
5. `feedback` must be a non-empty trimmed string → 400

**Mutation logic:**

1. Append tagged feedback to agentOutput:
   ```ts
   this.db.appendAgentOutput(taskId, `[user-revision-request] ${trimmedFeedback}\n`)
   this.broadcast({ type: "agent_output", payload: { taskId, output: `[user-revision-request] ${trimmedFeedback}\n` } })
   ```
2. Increment revision count:
   ```ts
   this.db.updateTask(taskId, {
     planRevisionCount: (task.planRevisionCount ?? 0) + 1,
     executionPhase: "plan_revision_pending",
   })
   ```
3. Broadcast `plan_revision_requested` event with the updated task:
   ```ts
   this.broadcast({ type: "plan_revision_requested", payload: this.db.getTask(taskId) })
   ```
4. Auto-start execution if not already running (same pattern as approve-plan):
   ```ts
   if (!this.getExecuting()) {
     const preflightError = this.getStartError()
     if (!preflightError) {
       this.onStart().catch((err) => this.reportExecutionStartFailure(err))
     }
   }
   ```
5. Return `{ ok: true }`

**Key difference from approve-plan:** The task status remains `"review"` (not changed to `"backlog"`). Only `executionPhase` becomes `"plan_revision_pending"` and `planRevisionCount` is incremented. This makes the task eligible for the orchestrator's re-planning path while keeping it visible in the review column.

### 3.2 Execution graph endpoint — add `planRevisionCount` to `pendingApprovals`

In the `GET /api/execution-graph` handler (~line 480), extend the `pendingApprovals` mapping:

```ts
graph.pendingApprovals = pendingApprovalTasks.map(t => ({
  id: t.id,
  name: t.name,
  status: t.status,
  awaitingPlanApproval: t.awaitingPlanApproval,
  planRevisionCount: t.planRevisionCount,  // NEW
}))
```

### 3.3 Task mutation lock behavior

The existing `handleHTTP` PATCH guard blocks edits during execution. The new revision-request endpoint should also be blocked when execution is running. This is already covered by the `getExecuting()` check in step 3.1. No additional changes needed.

---

## 4. Execution Plan — `.opencode/easy-workflow/execution-plan.ts`

### 4.1 Update `getExecutableTasks()`

Tasks in `plan_revision_pending` must be picked up by the orchestrator. They are currently skipped because `status` is `"review"` and they don't match `isBacklogTask` or `isApprovedPlanTask`.

**Change:** Extend the executable check:

```ts
const isBacklogTask = task.status === "backlog" && task.executionPhase !== "plan_complete_waiting_approval"
const isApprovedPlanTask = task.executionPhase === "implementation_pending"
const isRevisionPendingTask = task.executionPhase === "plan_revision_pending"
if (!isBacklogTask && !isApprovedPlanTask && !isRevisionPendingTask) continue
```

### 4.2 Update `ExecutionGraph` interface

Add optional `planRevisionCount` to the `pendingApprovals` item type:

```ts
pendingApprovals?: {
  id: string
  name: string
  status: string
  awaitingPlanApproval: boolean
  planRevisionCount?: number
}[]
```

---

## 5. Orchestrator — `.opencode/easy-workflow/orchestrator.ts`

### 5.1 In `executeTask()` — detect revision resume

Currently the function has:
```ts
const isPlanImplementationResume = task.planmode && task.executionPhase === "implementation_pending"
```

Add a sibling variable:
```ts
const isPlanRevisionResume = task.planmode && task.executionPhase === "plan_revision_pending"
```

### 5.2 In `executeTask()` — skip agentOutput clearing on revision resume

The existing code clears `agentOutput` when `isPlanImplementationResume` is false. The same guard should apply to `isPlanRevisionResume`:

```ts
// Mark executing
this.db.updateTask(task.id, {
  status: "executing",
  errorMessage: null,
  ...(isPlanImplementationResume || isPlanRevisionResume ? {} : { agentOutput: "" }),
})
```

### 5.3 In `executeTask()` — new plan-mode branch for revision

Inside the `if (task.planmode)` block, after the `isPlanImplementationResume` branch, add the revision branch:

```
if (!isPlanImplementationResume && !isPlanRevisionResume) {
  // PHASE 1: Original planning prompt (existing code, unchanged)
} else if (isPlanRevisionResume) {
  // PHASE 1b: Re-planning with user feedback
} else {
  // PHASE 2: Implementation (existing code, unchanged)
}
```

#### 5.3.1 Re-planning branch (`isPlanRevisionResume`)

Logic:
1. Read the previous plan output from `task.agentOutput`.
2. Extract the latest `[user-revision-request]` from `agentOutput` using regex:
   ```ts
   const revisionRequests = [...task.agentOutput.matchAll(/\[user-revision-request\]\s*([\s\S]*?)(?=\n\[|$)/g)]
   const latestRevisionRequest = revisionRequests.length > 0 ? revisionRequests[revisionRequests.length - 1][1].trim() : null
   ```
3. Extract the original plan text:
   ```ts
   const planMatch = task.agentOutput.match(/\[plan\]\s*([\s\S]*?)(?=\n\[|$)/)
   const originalPlan = planMatch ? planMatch[1].trim() : null
   ```
4. Assemble revision prompt:
   ```ts
   const revisionPrompt = [
     "The user has reviewed your plan and requested changes. Revise the plan based on their feedback.",
     `Original task:\n${task.prompt}`,
     originalPlan ? `Previous plan:\n${originalPlan}` : "",
     latestRevisionRequest ? `User feedback:\n${latestRevisionRequest}` : "",
     "Provide a revised plan that addresses the feedback. Output only the revised plan.",
   ].filter(Boolean).join("\n\n")
   ```
5. Send to planning agent (`agent: "plan"`) with plan model.
6. Extract output. On failure: throw error (task goes to `failed`).
7. Append revised plan to agentOutput:
   ```ts
   this.db.appendAgentOutput(task.id, `[plan] ${revisedPlanOutput}\n`)
   this.server.broadcast({ type: "agent_output", payload: { taskId: task.id, output: `[plan] ${revisedPlanOutput}\n` } })
   ```
8. Clean up worktree (same pattern as initial planning).
9. Set state back to review + awaiting:
   ```ts
   this.db.updateTask(task.id, {
     status: "review",
     awaitingPlanApproval: true,
     executionPhase: "plan_complete_waiting_approval",
     worktreeDir: shouldDeletePausedWorktree ? null : currentTask.worktreeDir,
   })
   ```
10. Broadcast `task_updated` and return early (halts execution, waits for user approval).

### 5.4 Implementation prompt — include all revision history

In the existing `isPlanImplementationResume` branch, the `userApprovalNote` extraction should also capture all `[user-revision-request]` entries so the implementation agent sees the full conversation history:

```ts
const revisionRequestMatches = [...task.agentOutput.matchAll(/\[user-revision-request\]\s*([\s\S]*?)(?=\n\[|$)/g)]
const revisionRequests = revisionRequestMatches.map(m => m[1].trim()).filter(Boolean)
const allUserGuidance = [
  ...revisionRequests.map((r, i) => `Revision request ${i + 1}:\n${r}`),
  userApprovalNote ? `Final approval note:\n${userApprovalNote}` : "",
].filter(Boolean).join("\n\n")
```

Then use `allUserGuidance` instead of just `userApprovalNote` in the implementation prompt:

```ts
text: [
  "The user has approved the plan below. Implement it now.",
  `Original task:\n${task.prompt}`,
  approvedPlanContext ? `Approved plan:\n${approvedPlanContext}` : "",
  allUserGuidance ? `User guidance:\n${allUserGuidance}` : "",
].filter(Boolean).join("\n\n"),
```

---

## 6. UI — `.opencode/easy-workflow/kanban/index.html`

### 6.1 Add "Request Changes" button to task cards

In the `renderCard()` function, where the "Approve Plan" button is rendered for `awaitingPlanApproval` tasks, add a second button:

```html
<button onclick="openRevisionModal('${task.id}')" style="...red/muted styling...">Request Changes</button>
```

### 6.2 Add revision modal — `#revisionModal`

New modal element (add to HTML after `#approveModal`):

```html
<div id="revisionModal" class="modal-overlay" style="display:none">
  <div class="modal" style="max-width:480px">
    <h3 id="revisionModalTitle">Request Plan Changes</h3>
    <p id="revisionModalTaskName" style="color:var(--muted);margin-bottom:8px"></p>
    <textarea id="revisionFeedback" rows="4" placeholder="What should be changed in the plan?" style="width:100%;margin-bottom:12px"></textarea>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button onclick="closeRevisionModal()">Cancel</button>
      <button onclick="confirmRequestRevision()" class="primary" style="background:var(--warn)">Send Feedback</button>
    </div>
  </div>
</div>
```

### 6.3 Add revision modal JavaScript functions

```js
function openRevisionModal(taskId) {
  const task = tasks.find(t => t.id === taskId)
  if (!task) return
  document.getElementById('revisionModal').style.display = 'flex'
  document.getElementById('revisionModalTaskName').textContent = task.name
  document.getElementById('revisionFeedback').value = ''
  document.getElementById('revisionFeedback').dataset.taskId = taskId
}

function closeRevisionModal() {
  document.getElementById('revisionModal').style.display = 'none'
}

async function confirmRequestRevision() {
  const feedback = document.getElementById('revisionFeedback').value.trim()
  const taskId = document.getElementById('revisionFeedback').dataset.taskId
  if (!feedback) { alert('Feedback cannot be empty'); return }
  const resp = await fetch(`/api/tasks/${taskId}/request-plan-revision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feedback }),
  })
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}))
    alert(err.error || 'Failed to request revision')
    return
  }
  closeRevisionModal()
}
```

### 6.4 Add "Request Changes" button to graph modal

In `renderGraphModal()`, in the pending approvals section, add a "Request Changes" button next to the existing "Approve" button for each pending approval entry:

```js
<div style="display:flex;gap:8px;align-items:center">
  <span>${approval.name}${approval.planRevisionCount > 0 ? ` (rev ${approval.planRevisionCount})` : ''}</span>
  <button onclick="approvePlan('${approval.id}')">Approve</button>
  <button onclick="openRevisionModal('${approval.id}')">Request Changes</button>
</div>
```

### 6.5 WebSocket handler for `plan_revision_requested`

In the `connectWS()` message handler, add a case:

```js
case 'plan_revision_requested':
  fetchAndRender()
  break
```

### 6.6 Visual indicator for revision count on cards

In `renderCard()`, when `task.planRevisionCount > 0`, show a badge:

```html
<span class="badge warn">revision ${task.planRevisionCount}</span>
```

---

## 7. Tests — `tests/test-kanban-plan-revision.ts`

### 7.1 New test file structure

```ts
#!/usr/bin/env bun
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { KanbanDB } from "../.opencode/easy-workflow/db"
import { KanbanServer } from "../.opencode/easy-workflow/server"
```

### 7.2 Test cases

| # | Test function | What it verifies |
|---|---------------|------------------|
| 1 | `testRequestRevisionBasic` | POST with valid feedback succeeds, appends `[user-revision-request]` to agentOutput, increments `planRevisionCount` to 1, sets `executionPhase` to `plan_revision_pending`, status stays `review`, `awaitingPlanApproval` stays `true` |
| 2 | `testRequestRevisionNoFeedback` | POST with empty body → 400 error, task unchanged |
| 3 | `testRequestRevisionWhitespaceOnly` | POST with whitespace-only feedback → 400 error |
| 4 | `testRequestRevisionNotAwaitingApproval` | POST when task is not in review/awaiting state → 400 error |
| 5 | `testRequestRevisionMultipleRounds` | Two consecutive revision requests, verify `planRevisionCount` is 2 and both `[user-revision-request]` entries appear in agentOutput |
| 6 | `testRequestRevisionDuringExecution` | POST while `getExecuting()` returns true → 409 error |
| 7 | `testRequestRevisionBroadcast` | Verify `plan_revision_requested` and `agent_output` WS events are broadcast |
| 8 | `testGetExecutableTasksIncludesRevisionPending` | Verify `getExecutableTasks()` picks up tasks with `executionPhase: "plan_revision_pending"` |
| 9 | `testRevisionCountResetOnReset` | Verify `resetTasksForBacklog()` resets `planRevisionCount` to 0 |

### 7.3 Test patterns (reuse from `test-kanban-approve-with-message.ts`)

- Create temp dir + db per test
- Spin up `KanbanServer` with mocked callbacks
- Intercept `broadcast()` calls to verify WS events
- Assert on task state after each operation
- Clean up in `finally` block

### 7.4 Update existing test: `test-kanban-orchestrator.ts`

Add a test case for the full revision loop:
1. Create planmode task
2. Run orchestrator → plan generated → task in review
3. Request revision via API
4. Run orchestrator again → revised plan generated → task back in review
5. Approve via API
6. Run orchestrator → implementation runs → task done

---

## 8. Execution Order

| Step | File(s) | Summary |
|------|---------|---------|
| 1 | `types.ts` | Add `plan_revision_pending` to `ExecutionPhase`, add `planRevisionCount` to `Task`, add `plan_revision_requested` WS type |
| 2 | `db.ts` | Add migration, update `rowToTask`, update `createTask`/`updateTask`, update `normalizeExecutionPhase`, update `resetTasksForBacklog` |
| 3 | `execution-plan.ts` | Update `getExecutableTasks` to include `plan_revision_pending`, update `ExecutionGraph` type |
| 4 | `server.ts` | Add `POST /request-plan-revision` endpoint, update `pendingApprovals` in graph endpoint |
| 5 | `orchestrator.ts` | Add `isPlanRevisionResume` detection, add re-planning branch, update implementation prompt assembly |
| 6 | `kanban/index.html` | Add revision modal, add "Request Changes" buttons to cards and graph modal, add WS handler |
| 7 | `tests/test-kanban-plan-revision.ts` | New test file with 9 test cases |
| 8 | `tests/test-kanban-orchestrator.ts` | Add full revision-loop E2E test |

---

## 9. Acceptance Criteria

- User can click "Request Changes" from a task card or the execution graph modal when a plan is awaiting approval.
- The revision modal requires non-empty feedback.
- After submitting feedback, the task stays in the review column with `awaitingPlanApproval: true` and `planRevisionCount` incremented.
- The orchestrator picks up `plan_revision_pending` tasks, re-runs the planning agent with the user's feedback, produces a revised plan, and puts the task back into review.
- The revised plan is appended to `agentOutput` as a new `[plan]` entry, preserving the full history.
- The user can approve after any number of revision rounds.
- On final approval, the implementation prompt includes the full chain of `[user-revision-request]` entries plus the final approval note.
- The board shows a revision count badge on cards that have been through revision.
- The graph modal shows "Request Changes" alongside "Approve" for pending approvals.
- All existing approval and execution tests pass without regression.
