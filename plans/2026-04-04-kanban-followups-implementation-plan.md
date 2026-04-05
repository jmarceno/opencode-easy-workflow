# 2026-04-04 Kanban Follow-ups Implementation Plan

## Goal

Implement follow-up improvements in Easy Workflow:

1. Reverse the ordering in the `Done` column so the most recently completed tasks appear first.
2. Show dependency references on cards by task number instead of task name, while keeping dependency selection in forms by full task name.
3. Make the embedded plugin server listen on all network interfaces so it can be accessed from other computers.
4. Add a visible indicator when a task is in `review` because the review agent is actively running, so the card does not look stalled.
5. Add timeout guidance to all workflow agents so shell commands are always run with explicit timeouts.
6. Disable keyboard shortcuts whenever any modal is open or the current focus is inside an input/editing control.

## Current Code Context

- The Kanban UI is a single embedded file: `.opencode/easy-workflow/kanban/index.html`.
- Task rendering and column grouping happen in `renderBoard()` and `renderCard()` in that file.
- Keyboard shortcuts are registered with a document-level `keydown` listener in `.opencode/easy-workflow/kanban/index.html`.
- Cards already display task numbers as `#${task.idx + 1}` in the header, but dependency badges still use dependency names.
- The `Done` column currently uses the same `idx` ascending sort as all other columns.
- The server is started in `.opencode/easy-workflow/server.ts` with `Bun.serve({ port })`, and the startup log still prints `http://localhost:${server.port}`.
- Review execution is handled in `runReviewLoop()` inside `.opencode/easy-workflow/orchestrator.ts`. The task is moved to `review`, but there is no dedicated review activity state exposed to the UI.
- Workflow subagent instructions live in `.opencode/agents/workflow-plan.md`, `.opencode/agents/workflow-build.md`, `.opencode/agents/workflow-build-fast.md`, `.opencode/agents/workflow-deep-thinker.md`, and `.opencode/agents/workflow-review.md`.
- Existing regression coverage already exists for the Kanban server, orchestrator, and web UI under `tests/`.

## Recommended Delivery Order

The best implementation order is:

1. Add the shared execution contract for active review state.
2. Update the UI interaction and presentation rules for shortcuts, dependency labels, and done-column ordering.
3. Make server binding/network URL behavior explicit.
4. Add timeout guidance across all workflow agents.
5. Expand regression coverage and update any affected docs.

This order keeps backend state changes ahead of UI consumption, isolates network behavior changes from UI work, and leaves the agent-instruction change as a low-risk cross-cutting cleanup near the end.

## Phase 1: Add Explicit Review Activity State

### Objective

Expose whether a task in the `review` column is actively being reviewed versus waiting for human action.

### Why First

- This is the only requested feature that likely needs a backend-to-UI contract change.
- The UI should render real state, not infer activity from incomplete heuristics.
- Implementing this first avoids layering presentation changes on top of ambiguous review behavior.

### Implementation Steps

1. Introduce a lightweight task-level activity field in the shared type model.
   Files:
   - `.opencode/easy-workflow/types.ts`
   - `.opencode/easy-workflow/db.ts`

2. Prefer a minimal, explicit field instead of overloading `status`.
   Recommended shape:
   - Add a nullable field such as `activityLabel`, `activityState`, or `reviewActivity`.
   - Keep `status` as `review` so existing column routing and workflow logic stay intact.
   - Use values narrow enough to support the requested feature without inventing a large new state machine.

3. Persist the new field in SQLite with a backward-compatible migration.
   In `db.ts`:
   - Add the new column to the `tasks` table definition.
   - Add a migration path for existing databases.
   - Include the field in `rowToTask()` and `updateTask()`.
   - Reset or clear the field in any recovery/reset helpers that restore task state.

4. Set and clear the field inside `runReviewLoop()` in `orchestrator.ts`.
   Expected behavior:
   - When the orchestrator starts the review agent, mark the task as `review` plus an active review indicator.
   - When review completes with `pass`, clear the indicator before returning to `executing`.
   - When review yields `blocked` or manual follow-up, clear the active indicator and leave the task visibly waiting in review/stuck.
   - When review requests another implementation pass, clear or change the indicator before the fix prompt is sent back to the worker session.

5. Keep the implementation minimal for now.
   Do not broaden this into a full generic workflow-step system unless the current code makes that unavoidable.

### UI Work for This Phase

In `.opencode/easy-workflow/kanban/index.html`:

1. Render a dedicated visual cue on review cards when the new field shows active review work.
2. Reuse the existing visual language if possible:
   - either a spinner near the title,
   - or a new badge such as `review running`.
3. Make the inactive case clearly different:
   - review waiting for user action should not show the running indicator.
4. If the card title links to a session, preserve that behavior.

### Validation

Add or update tests to prove the difference between:

- `review` while the review agent is running.
- `review` while waiting for user approval or manual action.

Likely files:

- `tests/test-kanban-web-ui.ts`
- `tests/test-kanban-orchestrator.ts`
- possibly `tests/test-kanban-plan-failure-handling.ts` or `tests/test-kanban-plan-revision.ts`

### Acceptance Criteria

- A task under active review has visible feedback on the card.
- A task waiting for manual review does not look like it is still actively executing review work.
- Existing review and plan-approval flows continue using the `review` column without regressions.

## Phase 2: Update Card Presentation Rules

### Objective

Implement the UI-only interaction and card presentation changes:

- reverse ordering in `Done`
- dependency labels shown by task number
- disable global shortcuts while a modal is open or text input focus is active

### Why Second

- These changes are self-contained in the UI and depend on no new server behavior.
- They are easiest to land after the review-state contract is settled.

### Feature A: Guard Keyboard Shortcuts During Modal/Input Interaction

Current behavior:

- The Kanban UI registers shortcuts through a document-level `keydown` handler.
- Shortcut handling currently risks firing while a modal is open or while the user is typing in an input field.

Implementation:

1. Centralize shortcut eligibility in a small helper inside `.opencode/easy-workflow/kanban/index.html`.
2. Block shortcut handling whenever any modal is open.
   Recommended implementation:
   - reuse or build on `getOpenModalIds()` so modal visibility is determined consistently.
3. Block shortcut handling whenever focus is inside an editable control.
   Cover at least:
   - `input`
   - `textarea`
   - `select`
   - editable Shoelace inputs/selects if they surface focus on internal controls
   - any element with `contenteditable`
4. Keep `Escape` behavior intentionally separated.
   Recommended behavior:
   - `Escape` should still close the topmost modal when a modal is open.
   - other global shortcuts such as `T`, `B`, `S`, and `D` should not fire while the modal is open.
5. Ensure shortcuts also stay suppressed while the user is typing into filters, prompts, names, or option inputs, even if no modal is open.

Files:

- `.opencode/easy-workflow/kanban/index.html`
- `tests/test-kanban-web-ui.ts`

Validation:

- Add or update UI tests that verify:
  - `T`, `B`, `S`, and `D` do nothing while a modal is open.
  - typing those same keys inside an input does not trigger shortcut actions.
  - `Escape` still closes the current modal.

Acceptance criteria:

- No global shortcut fires while any modal is open.
- No global shortcut fires while focus is inside an editable input control.
- Existing intentional modal-close behavior on `Escape` continues to work.

### Feature B: Reverse `Done` Column Ordering

Current behavior:

- `renderBoard()` groups tasks by status and sorts every group by `idx` ascending.

Implementation:

1. Keep the existing ordering for `template`, `backlog`, `executing`, and `review`.
2. Sort `done` tasks by recency instead of task index.
3. Use `completedAt` descending as the primary key.
4. Add a deterministic fallback for tasks without `completedAt` so migrated or repaired tasks remain stable.
   Recommended fallback order:
   - `completedAt` descending
   - then `updatedAt` descending
   - then `idx` ascending

File:

- `.opencode/easy-workflow/kanban/index.html`

Validation:

- Add a UI test that creates or mocks multiple done tasks and asserts newest-first order.
- If an existing non-UI test already checks completion times, keep it aligned with the UI expectation.

Acceptance criteria:

- The top card in `Done` is always the most recently completed task.
- Reopening the page preserves the same newest-first ordering.

### Feature C: Show Dependencies by Task Number on Cards

Current behavior:

- `renderCard()` resolves `task.requirements` to dependency names and renders `deps: <names>`.
- The dependency selector already shows full names plus task numbers, which matches the requested behavior and should remain unchanged.

Implementation:

1. Change only the card badge rendering logic.
2. Resolve dependencies to card numbers using `idx + 1`.
3. Render compact labels such as:
   - `deps: #2, #5`
4. Preserve the current dependency selector behavior in the task modal.
5. Decide how to handle deleted/missing dependencies:
   - omit unresolved references from the badge,
   - or show raw ids only if that is already the repo convention.
   The safer choice is to omit unresolved references in the badge because missing dependencies already represent inconsistent data.

Files:

- `.opencode/easy-workflow/kanban/index.html`
- optional test updates in `tests/test-kanban-web-ui.ts`

Validation:

- Add or update a UI test that verifies a card badge shows `#n` values, not dependency titles.
- Confirm the create/edit modal still lists dependency choices by full task name.

Acceptance criteria:

- Card badges show dependency numbers only.
- Modal dependency selection remains name-based for usability.
- No execution-graph or dependency-resolution logic changes are required.

## Phase 3: Bind the Plugin Server to All Addresses

### Objective

Make the Kanban server reachable from other devices on the network.

### Why Third

- This is mostly isolated to server startup and any user-facing URL reporting.
- It should be implemented after state/UI behavior is stable so network-specific failures are easier to isolate.

### Implementation Steps

1. Update `Bun.serve()` startup in `.opencode/easy-workflow/server.ts` to bind to all interfaces.
   Recommended change:
   - set `hostname: "0.0.0.0"`

2. Review all places that assume `localhost` in status or log output.
   At minimum:
   - startup log in `server.ts`
   - any helper or status text derived from the bound server address

3. Keep client/browser behavior origin-relative.
   The embedded UI already uses `location.host` for WebSocket and relative API paths, which is good and should continue working.

4. Decide how to report the access URL.
   Recommended behavior:
   - log the bound address as `0.0.0.0` for correctness,
   - optionally include a note that users should open the machine's LAN IP from another computer.

5. Review tests that hardcode `localhost` or `127.0.0.1`.
   The server can still be accessed via loopback locally even when bound to `0.0.0.0`, so many tests may need no functional change.
   Only update tests that assert the literal startup text or hostname.

6. Update user-facing docs if the project mentions local-only access.
   Likely candidates:
   - `README.md`
   - `INSTALL.md`
   - any plan/doc that describes the embedded server startup behavior

### Validation

- Run the relevant server and UI tests.
- Manually verify the process binds successfully and remains reachable via local loopback.
- If practical, add a small assertion around the configured hostname or startup log text, but avoid overfitting tests to log phrasing.

### Acceptance Criteria

- The server binds on all interfaces.
- Local browser access still works.
- Remote devices on the same network can reach the Kanban UI using the host machine IP and configured port.

## Phase 4: Add Timeout Guidance to All Workflow Agents

### Objective

Ensure every workflow agent is instructed to use explicit timeouts for shell commands so tasks do not run indefinitely.

### Why Fourth

- This change is broad but low-risk.
- It does not depend on the other feature work and is best handled as a consistency pass after the functional changes are scoped.

### Implementation Steps

1. Update all workflow agent instruction files under `.opencode/agents/`.
   Confirm coverage for:
   - `workflow-plan.md`
   - `workflow-build.md`
   - `workflow-build-fast.md`
   - `workflow-deep-thinker.md`
   - `workflow-review.md`

2. Add a short, explicit rule in each file.
   Recommended wording pattern:
   - whenever running shell commands, always specify a timeout
   - choose a timeout appropriate to the command
   - do not leave commands unbounded

3. Keep the guidance consistent across agent roles.
   The review agent should receive the same timeout requirement even though its bash access is restricted.

4. Review any tests that assert agent instruction content.
   Relevant existing coverage likely includes:
   - `tests/test-autonomy-instruction.ts`

5. If there are runtime prompts composed from these agent files, verify no formatting assumptions break when the new instruction line is added.

### Validation

- Update any agent-instruction tests to look for the timeout rule.
- Run the related test file(s).

### Acceptance Criteria

- Every workflow agent file contains explicit timeout guidance.
- Existing instruction tests still pass.
- No agent frontmatter or permission structure is broken by the wording change.

## Phase 5: Regression Coverage and Final Verification

### Test Focus

Run the smallest relevant suite first, then broaden if needed.

1. UI-focused tests
   - `tests/test-kanban-web-ui.ts`

2. Orchestrator/state tests
   - `tests/test-kanban-orchestrator.ts`
   - `tests/test-kanban-plan-revision.ts`
   - `tests/test-kanban-plan-failure-handling.ts`

3. Agent-instruction tests
   - `tests/test-autonomy-instruction.ts`

4. Any server-specific tests impacted by host binding
   - `tests/test-kanban-skip-permission.ts`
   - `tests/test-kanban-approve-with-message.ts`

### Manual Verification Checklist

1. Start the Kanban server and confirm the UI loads locally.
2. Confirm shortcuts do not trigger while a modal is open.
3. Confirm typing inside task or options inputs does not trigger global shortcuts.
4. Confirm `Done` shows newest items first.
5. Confirm dependency badges show `#n` labels.
6. Confirm the dependency selector still uses full names.
7. Trigger a task that enters automated review and verify the card shows an active review indicator.
8. Trigger a review/manual-attention state and verify the active indicator is absent.
9. Open the Kanban UI from another computer using the host machine IP and configured port.

## Suggested Implementation Task Breakdown

1. Add persisted review-activity state and wire it through `types.ts`, `db.ts`, and `orchestrator.ts`.
2. Render active review feedback in `kanban/index.html` and cover it with UI/orchestrator tests.
3. Guard document-level shortcuts so they do not fire while a modal is open or while focus is inside editable inputs.
4. Change `Done` column sorting to newest-first using `completedAt`-based ordering.
5. Change dependency badges to show task numbers only, without altering modal selection behavior.
6. Bind `Bun.serve()` to `0.0.0.0` and update any user-visible address text/docs.
7. Add timeout guidance to all workflow agent instruction files.
8. Run targeted regression tests and address any breakages.

## Order Rationale Summary

- Review activity first because it needs a real state contract, not just UI polish.
- Shortcut guards, UI sorting, and dependency-label changes second because they are isolated UI work and low-risk once state behavior is clear.
- Network binding third because it changes deployment behavior but not task logic.
- Agent timeout guidance fourth because it is cross-cutting documentation/instruction work.
- Regression and manual verification last to confirm the full change set behaves coherently.
