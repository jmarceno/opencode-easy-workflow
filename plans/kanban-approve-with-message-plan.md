# Kanban Approve With Message Plan

## Goal

Add a way to respond to the agent from the Kanban UI at approval time so the user can make plan adjustments without leaving the board.

## Product Behavior

- Approval remains a single action that starts implementation.
- Clicking **Approve Plan** opens a small modal with an optional message field.
- If the message is empty, behavior stays the same as today.
- If a message is provided, it is attached to approval and included in the implementation context.

## User Experience

- Surface the same flow from both places:
  - Task cards in the Review column
  - The execution graph modal
- Approval modal contents:
  - Task name
  - Optional textarea: "Message to agent"
  - Buttons: **Approve and Run** and **Cancel**

## API Contract

Extend the existing endpoint:

- `POST /api/tasks/:id/approve-plan`
- Request body (optional):
  - `message?: string`

Rules:

- Keep current approval preconditions and mutation guards.
- Trim message text.
- Ignore empty strings after trim.
- Preserve idempotent behavior when plan is already approved.

## State Transitions

Keep current transition logic:

- `status: review` + `awaitingPlanApproval: true` + `executionPhase: plan_complete_waiting_approval`
- On approve:
  - `awaitingPlanApproval: false`
  - `executionPhase: implementation_pending`
  - `status: backlog`

## Agent Context Handling

When approval includes a message:

- Persist a tagged entry in `agentOutput`, for example:
  - `[user-approval-note] <message>`
- Broadcast `agent_output` so the UI updates live.

When implementation resumes in plan mode:

- Include the original task prompt.
- Include plan output.
- Include the user approval note as explicit implementation guidance.

## Execution Graph Integration

Current graph data only includes executable tasks, so approval-pending tasks are not visible there.

Add `pendingApprovals` to `/api/execution-graph` response so the graph modal can render actionable approval rows:

- `id`
- `name`
- `status`
- `awaitingPlanApproval`

This keeps execution graph batching logic unchanged while still enabling approval from inside the modal.

## Implementation Steps

1. Update approval API in `.opencode/easy-workflow/server.ts` to accept optional `message`.
2. Append tagged approval notes to `agentOutput` when message is present.
3. Ensure `task_updated` and `agent_output` events are broadcast correctly.
4. Update plan-mode implementation prompt assembly in `.opencode/easy-workflow/orchestrator.ts` to include approval note context.
5. Add approval modal UI and wire all **Approve Plan** entry points in `.opencode/easy-workflow/kanban/index.html`.
6. Extend graph modal render to include `pendingApprovals` actions.
7. Add or update tests for:
   - API approve with and without message
   - UI approve modal behavior
   - Plan-mode resume context and state transitions

## Acceptance Criteria

- User can approve with or without a message from task card and graph modal.
- Approval with message transitions task exactly as current approval does.
- Message is visible in task output and used by implementation prompt context.
- Existing approval flows continue to pass without regression.
