# Reliable Permission Bypass Plan

## Goal

Implement a workflow-owned permission bypass that prevents OpenCode permission prompts from interrupting Easy Workflow execution.

Target behavior:

- tasks with `skipPermissionAsking=true` do not pause for routine permission prompts
- the bypass applies to all workflow-created sessions, including:
  - main task execution sessions
  - plan sessions and plan revision sessions
  - best-of-n worker sessions
  - best-of-n reviewer sessions
  - best-of-n final-applier sessions
  - review scratch sessions
  - repair sessions
- tasks with `skipPermissionAsking=false` remain interactive
- unrelated non-workflow sessions are never affected

## Current Failure Modes

### 1. Auto-reply uses `once`, so prompts keep coming back

Current code in `.opencode/plugins/easy-workflow.ts` responds to `permission.asked` with `response: "once"`.

That only clears a single permission request. It does not establish a durable allow rule for the rest of the session, so a long-running autonomous workflow can still surface many prompts.

### 2. Ownership lookup is tied to the local plugin instance DB

The current auto-reply handler infers workflow ownership by scanning the local `tasks` and `task_runs` tables.

This is not reliable because the plugin is initialized both:

- in the root project directory
- inside workflow-created worktree directories

Worktree-local plugin instances use their own local `.opencode/easy-workflow/tasks.db`, which does not contain the root workflow task/session metadata.

Result:

- a real permission event can arrive in a worktree plugin instance
- that instance cannot prove session ownership from its local DB
- the event is skipped even though the session is workflow-owned

### 3. Some workflow-created sessions are never registered for ownership at all

Current fallback logic only covers sessions that happen to be stored in `tasks.session_id` or `task_runs.session_id`.

That misses important workflow sessions such as:

- review scratch sessions created in `runReviewLoop()`
- repair sessions created in `server.ts`

If those sessions hit permission prompts, the current bypass cannot reliably identify them as workflow-owned.

### 4. Runtime event payloads are not always complete enough for the current handler

The current handler assumes the permission event contains enough information to directly identify the session and request.

The debug log already shows real `permission.asked` events being skipped because `sessionId` was missing.

### 5. Review behavior is still permission-prompt prone

`workflow-review.md` intentionally asks for most bash permissions today.

That may be appropriate for interactive review, but it conflicts with the product goal when review runs are part of an autonomous workflow path.

## Design Principles

1. Scope the bypass to workflow-owned sessions only.
2. Make ownership resolution explicit instead of inferred.
3. Make the bypass durable for the lifetime of the session.
4. Keep review and repair in scope.
5. Preserve interactive behavior for `skipPermissionAsking=false`.
6. Support both current and newer OpenCode permission APIs.

## Proposed Solution

Implement permission bypass in three layers:

1. Explicit workflow session registry
2. Root-owner resolution shared across root and worktree plugin instances
3. Durable `permission.reply(..., "always")` handling for registered sessions

This makes the bypass reliable even when the permission event is handled by a plugin instance running inside a worktree.

## Architecture

### 1. Add a root-level workflow session registry

Create a new registry persisted in the root workflow DB.

Recommended table:

`workflow_sessions`

Suggested columns:

- `session_id TEXT PRIMARY KEY`
- `task_id TEXT`
- `task_run_id TEXT`
- `session_kind TEXT NOT NULL`
- `owner_directory TEXT NOT NULL`
- `skip_permission_asking INTEGER NOT NULL`
- `permission_mode TEXT NOT NULL DEFAULT 'always'`
- `status TEXT NOT NULL DEFAULT 'active'`
- `created_at INTEGER NOT NULL DEFAULT (unixepoch())`
- `updated_at INTEGER NOT NULL DEFAULT (unixepoch())`

Suggested `session_kind` values:

- `task`
- `task_run_worker`
- `task_run_reviewer`
- `task_run_final_applier`
- `review_scratch`
- `repair`
- `plan`
- `plan_revision`

Suggested `status` values:

- `active`
- `completed`
- `deleted`
- `stale`

Implementation guidance:

- store the registry in the root workflow DB, not in the worktree-local DB
- add focused DB helpers rather than open-coded SQL in plugin/orchestrator code

## 2. Resolve the root workflow owner from any plugin instance

The plugin must be able to resolve the root workflow owner even when running inside a worktree.

Recommended approach:

- define the root workflow owner as the original project directory that owns the authoritative Kanban DB
- whenever the orchestrator creates a workflow worktree, write a small pointer file into that worktree

Suggested file:

`.opencode/easy-workflow/root-owner.json`

Suggested contents:

```json
{
  "ownerDirectory": "/absolute/path/to/root/project",
  "rootDbPath": "/absolute/path/to/root/project/.opencode/easy-workflow/tasks.db"
}
```

Plugin startup behavior:

- if `root-owner.json` is absent, treat the current directory as the owner
- if `root-owner.json` exists, open the root DB referenced there for workflow session lookup/registration
- continue to allow local worktree plugin initialization, but never use the local worktree DB as the source of truth for permission bypass ownership

This is the key fix for the current root/worktree mismatch.

### 3. Register every workflow-created session immediately after creation

As soon as the workflow code creates a session and receives its `sessionId`, it must register that session in the root registry.

Required registration points:

#### Orchestrator main task flow

Register the task session created in `.opencode/easy-workflow/orchestrator.ts`.

#### Plan and plan revision flow

If planning/revision use the same main task session, no extra session kind is required beyond task-level registration.

If these flows become separate sessions later, they must also be explicitly registered.

#### Best-of-n worker flow

Register worker sessions with `session_kind = task_run_worker`.

#### Best-of-n reviewer flow

Register reviewer sessions with `session_kind = task_run_reviewer`.

#### Best-of-n final applier flow

Register final-applier sessions with `session_kind = task_run_final_applier`.

#### Review scratch flow

Register the scratch session created inside `runReviewLoop()` with `session_kind = review_scratch`.

This is mandatory for review to be included in the bypass.

#### Repair flow

Register the smart-repair session created in `.opencode/easy-workflow/server.ts` with `session_kind = repair`.

This is mandatory for repair to be included in the bypass.

### 4. Change permission response mode to `always`

For workflow-owned sessions with `skipPermissionAsking=true`, reply with:

- `always`

Do not keep `once` as the default for these sessions.

Rationale:

- the product goal is no permission interruption for workflow-owned autonomous sessions
- `once` is fundamentally incompatible with that goal for multi-step sessions
- `always` is safe here because the bypass is tightly scoped by explicit workflow ownership

### 5. Prefer the newer permission reply API, with compatibility fallback

OpenCode SDK v2 exposes a newer API:

- `client.permission.reply({ requestID, reply: "always" })`

The current implementation uses the older API:

- `client.permission.respond({ sessionID, permissionID, response: "once" })`

Recommended event handling strategy:

1. Extract `requestID` from `event.properties.id`, `event.properties.requestID`, or compatible fields.
2. Extract `sessionID` from the event if present.
3. If `sessionID` is missing but `requestID` is present, call `client.permission.list()` and resolve the pending request to recover the session.
4. Look up the session in the root workflow session registry.
5. If the session is registered and `skipPermissionAsking=true`, call:
   - first choice: `client.permission.reply({ requestID, reply: "always" })`
   - fallback: `client.permission.respond({ sessionID, permissionID, response: "always" })`
6. Log which path was used.

If both `requestID` and `sessionID` are missing, log and skip.

### 6. Keep review and repair autonomous by design, not just by fallback

The event-driven bypass should be the hard guarantee, but review and repair should also avoid creating unnecessary permission events in the first place.

Recommended changes:

#### Add `workflow-review-autonomous.md`

Purpose:

- autonomous workflow review without permission pauses
- still no edits

Recommended permission frontmatter:

```yaml
permission:
  edit: deny
  webfetch: deny
  bash: allow
```

Notes:

- this keeps review read-only while avoiding routine bash prompts
- use this agent when `skipPermissionAsking=true`
- keep existing `workflow-review` for interactive review behavior when `skipPermissionAsking=false`

#### Add `workflow-repair.md`

Purpose:

- workflow-owned state repair analysis
- JSON-only output
- no code edits

Recommended permission frontmatter:

```yaml
permission:
  edit: deny
  webfetch: deny
  bash: allow
```

Use this agent for repair sessions when the owning workflow task is autonomous.

This reduces pressure on the fallback layer and makes repair consistent with the autonomy goal.

### 7. Add registry lifecycle cleanup

The registry should not grow forever.

Recommended cleanup behavior:

- mark sessions `completed` when their workflow phase ends
- mark sessions `deleted` when session auto-delete succeeds
- run opportunistic cleanup on plugin startup or orchestrator start
- mark entries `stale` when they are old and no longer correspond to a live session

Cleanup is not required for correctness, but it improves maintainability and debugging.

## File-Level Plan

### `.opencode/easy-workflow/db.ts`

Add:

- `workflow_sessions` table migration
- typed row mapping if needed
- registry CRUD helpers such as:
  - `registerWorkflowSession(...)`
  - `getWorkflowSession(sessionId)`
  - `markWorkflowSessionStatus(sessionId, status)`
  - `cleanupStaleWorkflowSessions(...)`

### `.opencode/plugins/easy-workflow.ts`

Change:

- root owner resolution
- DB selection for permission bypass lookup
- permission event handling
- support for `permission.reply()` plus `permission.respond()` fallback
- fallback recovery with `permission.list()` when `sessionID` is missing
- richer logging for registry hits/misses and reply method used

### `.opencode/easy-workflow/orchestrator.ts`

Add:

- session registration immediately after every workflow session creation
- worktree root-owner pointer file creation
- autonomous review agent routing when `skipPermissionAsking=true`
- registration and cleanup for review scratch sessions

### `.opencode/easy-workflow/server.ts`

Add:

- repair session registration
- root-owner pointer handling if this code creates workflow worktrees directly
- autonomous repair agent routing when appropriate

### `.opencode/agents/workflow-review-autonomous.md`

Add new autonomous review agent.

### `.opencode/agents/workflow-repair.md`

Add new repair agent.

## Detailed Runtime Flow

### Session creation flow

1. Workflow code creates a session.
2. Workflow code immediately registers the session in the root registry.
3. If the session is tied to a worktree, the worktree contains `root-owner.json` pointing back to the root owner.

### Permission event flow

1. Any plugin instance receives `permission.asked`.
2. The plugin resolves the root workflow owner.
3. The plugin loads the root registry.
4. The plugin identifies the request and session.
5. The plugin checks whether the session is registered and autonomous.
6. If yes, it auto-replies with `always`.
7. If no, it does nothing.

### Review flow

1. Review scratch session is created.
2. Session is registered as `review_scratch`.
3. If the task is autonomous, use `workflow-review-autonomous`.
4. If any permission event still appears, the event hook auto-replies with `always`.

### Repair flow

1. Repair session is created.
2. Session is registered as `repair`.
3. If the owning task is autonomous, use `workflow-repair`.
4. If any permission event still appears, the event hook auto-replies with `always`.

## Testing Plan

### Unit/integration tests for registry behavior

Add tests for:

- registry insert/update/read helpers
- root-owner resolution from worktree directories
- registry lookup from a worktree plugin instance against the root DB

### Permission auto-reply tests

Add or expand tests for:

- main task session auto-replies with `always`
- worker session auto-replies with `always`
- reviewer session auto-replies with `always`
- final-applier session auto-replies with `always`
- review scratch session auto-replies with `always`
- repair session auto-replies with `always`
- `skipPermissionAsking=false` does not auto-reply
- non-workflow sessions do not auto-reply
- missing `sessionID` event path recovered through `permission.list()`
- newer `permission.reply()` path is used when available
- deprecated `permission.respond()` fallback still works if needed

### Worktree coverage tests

Add tests that simulate:

- plugin initialized in root repo
- plugin initialized in workflow-created worktree
- permission event handled from worktree context but resolved via root registry

This is necessary because the current failure is largely caused by root/worktree separation.

### Review and repair tests

Add tests for:

- `runReviewLoop()` review scratch session registration
- best-of-n reviewer session registration
- smart-repair session registration
- autonomous review agent routing
- autonomous repair agent routing

## Suggested Implementation Order

1. Add root-owner pointer design and workflow session registry schema.
2. Add DB helpers for workflow session registration and lookup.
3. Update plugin startup to resolve the root owner from root or worktree context.
4. Register main task, worker, reviewer, and final-applier sessions.
5. Register review scratch sessions.
6. Register repair sessions.
7. Update permission event handling to use root registry plus `always` replies.
8. Add `permission.reply()` support with fallback to `permission.respond()`.
9. Add `workflow-review-autonomous.md` and route autonomous review through it.
10. Add `workflow-repair.md` and route autonomous repair through it.
11. Add cleanup hooks for completed/deleted sessions.
12. Add targeted tests for root/worktree behavior and full session coverage.

## Risks And Mitigations

### Risk: over-bypassing permissions for unrelated sessions

Mitigation:

- only bypass sessions present in the explicit workflow session registry
- never infer from session title alone
- never bypass when `skipPermissionAsking=false`

### Risk: worktree instance cannot resolve the root owner

Mitigation:

- write `root-owner.json` into every workflow-created worktree
- log loudly when the pointer is missing or invalid
- fail closed: no bypass if ownership cannot be proven

### Risk: SDK/API drift between `reply` and `respond`

Mitigation:

- implement both paths
- prefer `reply`
- keep explicit debug logging for the chosen API path

### Risk: review becomes too permissive

Mitigation:

- keep edit denied for autonomous review
- keep webfetch denied unless there is a real requirement to broaden it later
- split interactive and autonomous review agents instead of overloading one file

## Acceptance Criteria

This plan is complete when the implementation can demonstrate all of the following:

1. A workflow-owned autonomous task session does not pause for permission prompts.
2. A best-of-n worker session does not pause for permission prompts.
3. A best-of-n reviewer session does not pause for permission prompts.
4. A final-applier session does not pause for permission prompts.
5. A review scratch session does not pause for permission prompts.
6. A repair session does not pause for permission prompts.
7. The same behavior still works when the permission event is handled inside a worktree plugin instance.
8. Tasks with `skipPermissionAsking=false` still behave interactively.
9. Non-workflow sessions are untouched.

## Recommendation

Implement the bypass as an explicit root-scoped session registry plus durable `always` permission replies.

That is the most reliable path available in the current OpenCode/plugin architecture, and it is the only approach that properly includes review and repair without accidentally broadening behavior to unrelated sessions.
