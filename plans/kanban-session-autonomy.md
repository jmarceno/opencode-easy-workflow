# Kanban Session Autonomy Plan

## Goal

Reduce workflow interruptions so Kanban tasks run with minimal user intervention by default.

The two concrete problems to solve are:

- permission prompts during task execution
- assistant follow-up questions in the middle of a run

## Summary Of Recommended Approach

Implement autonomy in three layers:

1. Add a per-task `skipPermissionAsking` option, defaulting to `true`
2. Route autonomous tasks through dedicated workflow agents with permissive OpenCode `permission` settings
3. Strengthen orchestrator prompt instructions so agents continue with reasonable assumptions and only ask questions when truly blocked

Keep a plugin-level permission auto-reply path as a fallback if agent permissions still produce prompts that interrupt Kanban execution.

## Key Constraint

Do not design this around passing a permission ruleset into `session.create()`.

Current SDK v2 types only expose `parentID` and `title` for session creation, so there is no reliable per-session permission payload to send from the orchestrator today.

Implication:

- per-task autonomy should be implemented through agent selection and prompting first
- event-driven permission auto-reply can be added afterward if needed

## Desired Behavior

### Default behavior

- Newly created tasks default to `skipPermissionAsking=true`
- Newly created tasks default to using prompts that discourage mid-run user questions
- Plan-mode tasks can still pause only when explicit human approval is intentionally required

### When `skipPermissionAsking=true`

- Execution runs should prefer workflow-specific agents whose permissions are configured to `allow` for normal task work
- The session should avoid asking the user for tool permissions for routine edit/bash/web access
- The model should continue by making reasonable assumptions unless blocked by missing credentials, missing required external input, or a truly irreversible product decision

### When `skipPermissionAsking=false`

- Existing agent and permission behavior should remain unchanged
- The task should preserve the more interactive execution style

## Scope

### In scope

- task schema and persistence changes
- task create/edit API support
- Kanban UI checkbox support
- autonomous agent definitions
- orchestrator agent routing changes
- prompt/system instruction hardening to reduce mid-run questions
- tests for default values, routing, and prompt composition

### Out of scope

- changing global OpenCode behavior outside this workflow plugin by default
- forcing autonomy for non-Kanban sessions
- redesigning OpenCode core permission APIs

## Data Model Changes

Update `.opencode/easy-workflow/types.ts`:

- Add `skipPermissionAsking: boolean` to `Task`

Update `.opencode/easy-workflow/db.ts`:

- Add `skip_permission_asking INTEGER NOT NULL DEFAULT 1` to the `tasks` table
- Add a migration for existing databases
- Include the field in row-to-task mapping
- Include the field in `createTask()`
- Include the field in `updateTask()`

Default:

- `true` for newly created tasks

Compatibility:

- existing rows should be backfilled by migration default behavior

## API Changes

Update `.opencode/easy-workflow/server.ts` request validation and task mutation handling.

### Task create/update payloads

Allow:

- `skipPermissionAsking?: boolean`

Validation:

- reject non-boolean values the same way existing task boolean fields are validated

Implementation note:

- extend the existing boolean-field validation helper rather than creating a second path

## UI Changes

Update `.opencode/easy-workflow/kanban/index.html`.

### Task modal

Add checkbox:

- label: `Skip Permission Asking`
- default: checked
- help text: indicates the workflow will use a more autonomous agent configuration for the task

### Task load/save flows

- populate the checkbox from `task.skipPermissionAsking`
- include it in create/update payloads
- when cloning/seeding from an existing task, preserve the field

### Optional UX improvement

If useful, add a small badge on cards when autonomy is enabled:

- `auto permissions`

This is optional and can be deferred if the card UI feels too busy.

## Agent Strategy

Preferred implementation is agent-based autonomy.

### New agents

Add dedicated project-local agents under `.opencode/agents/`:

- `workflow-plan.md`
- `workflow-build.md`
- `workflow-build-fast.md`
- `workflow-deep-thinker.md`

These should mirror the existing task-oriented agents but include explicit `permission` config.

### Permission policy

Use permissive defaults for workflow-owned task execution:

```yaml
permission:
  edit: allow
  bash:
    "*": allow
  webfetch: allow
```

If you want a safer variant, bash can still special-case obviously risky commands later, but the first implementation should stay simple and match the product goal of minimizing intervention.

### Prompt policy inside the autonomous agents

Add short instructions like:

- continue end-to-end without asking the user for confirmation unless truly blocked
- make reasonable assumptions from repository context
- only ask questions when blocked by missing credentials, missing required external input, or an irreversible product decision
- if multiple valid implementations exist, choose the smallest reasonable one and proceed

Keep these prompts concise. The autonomy behavior should come mostly from permissions plus one strong execution rule, not from long agent prose.

## Orchestrator Changes

Update `.opencode/easy-workflow/orchestrator.ts`.

### Agent selection

When `task.skipPermissionAsking === true`:

- plan-mode planning and revision prompts should use `workflow-plan`
- low thinking execution should use `workflow-build-fast`
- default or medium thinking execution should use `workflow-build`
- high thinking execution should use `workflow-deep-thinker`

When `task.skipPermissionAsking === false`:

- preserve current behavior
- `plan` for planning
- existing thinking-level agent mapping for execution

### Prompt hardening to reduce mid-run questions

For execution prompts, prepend a short instruction block such as:

```text
Execute the task end to end with minimal user intervention.
Do not ask follow-up questions unless you are blocked by missing credentials, missing required external input, or an irreversible product decision.
Make reasonable assumptions from the codebase and continue.
```

Apply the same idea to:

- direct execution prompts
- plan-mode implementation prompts
- plan-mode planning prompts
- plan revision prompts
- best-of-n worker/final-applier prompts if they use the same session prompt path

This should reduce model-initiated questions even when permissions are already permissive.

### Plan mode nuance

`skipPermissionAsking` should not bypass intentional product pauses caused by workflow logic.

Specifically:

- if `autoApprovePlan=false`, a plan-mode task may still stop for explicit plan approval
- if the product goal is “minimal interruption”, prefer making `autoApprovePlan=true` the default for new tasks, but treat that as a separate decision from permission autonomy

## Review And Follow-Up Runs

Review sessions are not the main source of permission interruptions, but they should stay consistent.

Recommended behavior:

- continue using existing review agent behavior unless review runs are also hitting permission prompts in practice
- if review runs do hit permissions, add a dedicated `workflow-review-autonomous` agent later instead of broadening scope now

## Fallback: Permission Auto-Reply

If agent-based permissions do not eliminate all permission pauses, add a second layer using plugin event hooks.

### Mechanism

Use plugin event handling for:

- `permission.updated` / `permission.asked`-style permission events

For workflow-owned sessions only:

- inspect the permission event
- if the session belongs to a task with `skipPermissionAsking=true`, reply automatically through the SDK permission response endpoint

SDK route already exists for this pattern:

- `POST /session/{id}/permissions/{permissionID}` with response `once` or `always`

### Guardrails

Only auto-reply for sessions created by the Kanban orchestrator.

Do not auto-reply for:

- unrelated user sessions
- workflow tasks with `skipPermissionAsking=false`

### Suggested response mode

Start with:

- `once`

Use `always` only if repeated prompts for the same rule still interrupt execution and the behavior is clearly scoped to workflow sessions.

### Implementation shape

Maintain a session-to-task lookup based on task `sessionId` and task-run `sessionId` values already stored in the DB.

This fallback should be implemented only after the agent-based approach is tested, because it is more invasive and easier to get wrong.

## Testing Plan

### Unit/integration coverage

Update or add tests for:

- task creation defaults `skipPermissionAsking=true`
- task update persistence for `skipPermissionAsking`
- API validation rejects non-boolean `skipPermissionAsking`
- UI create/edit flows preserve the checkbox state
- orchestrator chooses autonomous agents when `skipPermissionAsking=true`
- orchestrator preserves existing agents when `skipPermissionAsking=false`
- autonomy instruction text is included in prompt payloads for execution and planning

### Files likely involved

- `tests/test-kanban-web-ui.ts`
- `tests/test-kanban-orchestrator.ts`
- possibly a focused new test for task schema persistence if that is cleaner than expanding current coverage

### Optional fallback tests

If permission auto-reply is implemented:

- auto-reply only happens for workflow-owned session IDs
- auto-reply is skipped when the task disables autonomy
- permission response endpoint is called with the expected `permissionID`

## Suggested Implementation Order

1. Add `skipPermissionAsking` to types, DB schema, migrations, and server payload validation
2. Add the checkbox to the Kanban task modal and wire it through create/edit flows
3. Add dedicated autonomous agent files under `.opencode/agents/`
4. Update orchestrator agent routing based on `skipPermissionAsking`
5. Add compact autonomy instructions to prompt construction points
6. Run and fix tests for DB, API, UI, and orchestrator behavior
7. Evaluate whether permission prompts still appear in practice
8. Only if needed, implement plugin-level permission auto-reply for workflow-owned sessions

## Open Decisions

### Decision 1: default `autoApprovePlan`

If the product goal is truly “run without user intervention as much as possible”, consider making `autoApprovePlan=true` the default for new tasks.

Pros:

- removes the largest intentional pause in plan-mode tasks

Cons:

- changes current human-approval semantics for plan mode

Recommendation:

- keep this as a separate change unless product explicitly wants plan-mode autonomy by default

### Decision 2: command-specific bash restrictions

For the first pass, prefer broad `bash` allow rules to match the stated goal.

If needed later, refine with command-specific `ask` rules for commands such as:

- `git push*`
- destructive workspace operations

Recommendation:

- do not over-engineer the first version

## Success Criteria

The change is successful when:

- a newly created task defaults to autonomous permission behavior
- the orchestrator runs the task without routine permission prompts
- agent follow-up questions during execution are substantially reduced
- users can opt out per task and recover the existing interactive behavior
- existing non-workflow OpenCode sessions remain unaffected
