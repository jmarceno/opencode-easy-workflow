# Plan-Mode Approval Workflow

## Goal

Design a workflow for tasks that start in plan mode so they can pause for explicit user approval before implementation continues.

## Required Behavior

- Execute planning first
- Stay in review when planning is done
- Allow user approval later
- Return to execution after approval
- Continue through normal review/done flow like any other task

## Proposed State Flow

- `backlog` -> `executing` (planning phase only) for `planmode=true`
- Planning completes -> move to `review` with `awaitingPlanApproval=true`
- User triggers **Approve Plan**
- Task returns to execution queue and runs implementation phase
- After implementation:
  - If `review=true`: run normal review loop
  - If `review=false`: mark `done`

## Data Model Updates

Update `.opencode/easy-workflow/types.ts` and DB persistence:

- Add `executionPhase`:
  - `not_started`
  - `plan_complete_waiting_approval`
  - `implementation_pending`
  - `implementation_done`
- Add `awaitingPlanApproval: boolean`

Notes:

- Keep existing `status` values (`backlog`, `executing`, `review`, etc.) to preserve current board columns.

## Orchestrator Changes

In `.opencode/easy-workflow/orchestrator.ts`:

1. Include executable candidates from:
   - Normal backlog tasks
   - Plan-approved tasks (`executionPhase=implementation_pending`)

2. For `planmode=true` with `executionPhase=not_started`:
   - Run planning prompt only
   - Store `[plan]` output
   - Set:
     - `status="review"`
     - `awaitingPlanApproval=true`
     - `executionPhase="plan_complete_waiting_approval"`
   - Return early (do not run implementation yet)

3. For approved plan tasks (`implementation_pending`):
   - Run implementation prompt
   - Continue existing review loop, merge/delete worktree, and completion flow

Dependency behavior:

- Tasks awaiting plan approval are not `done`, so dependents remain blocked.

## API Changes

In `.opencode/easy-workflow/server.ts`:

- Add `POST /api/tasks/:id/approve-plan`
- Validate task is in `review` and `awaitingPlanApproval=true`
- Transition task to:
  - `awaitingPlanApproval=false`
  - `executionPhase="implementation_pending"`
  - `status="backlog"` (or another execution-eligible status)
- Broadcast `task_updated`
- If orchestrator is idle, trigger execution start
- Make endpoint idempotent for repeated approval calls

## UI Changes

In `.opencode/easy-workflow/kanban/index.html`:

- Show **Approve Plan** button on review cards where `awaitingPlanApproval=true`
- Add badge: `plan approval pending`
- Add event log entry when approved

## Edge Cases

- Approval while orchestrator is already running: queue safely for next available execution slot
- Duplicate approval requests: no-op success response
- Stop command while waiting approval: keep task in review pending approval
- Reset to backlog: clear plan-approval and phase metadata

## Testing

Update tests to cover the full lifecycle:

- `test-kanban-orchestrator.ts`
  - Plan-mode task stops in review awaiting approval
  - Approval resumes execution and reaches review/done
  - Dependencies stay blocked until implementation completion

- `test-kanban-web-ui.ts`
  - Approve Plan button visibility and action
  - Expected state transitions reflected in API and UI
