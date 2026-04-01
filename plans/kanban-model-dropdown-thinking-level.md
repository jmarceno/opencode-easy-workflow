# Kanban Web UI - Model Dropdown + Thinking Level (Agent-Based) Plan

## Goal

Implement two Kanban Web UI capabilities:

1. Select models from dropdowns (task-level and global options) instead of free-text inputs.
2. Make "thinking level" configurable using agent-based presets (Option 1), not per-call model params.

This plan keeps the existing execution flow and adds predictable, provider-safe controls.

## Why Agent-Based Thinking Level

- The current SDK prompt shape used by this project does not expose arbitrary provider-specific reasoning knobs directly in the task prompt payload.
- Agent config supports pass-through provider-specific options (for example `reasoningEffort`), so we can safely map UI levels to named agents.
- This avoids runtime global config mutation and works correctly with parallel task execution.

## Scope

In scope:
- New backend API to provide model catalog for UI dropdowns.
- Replace model text inputs with dropdown controls in Kanban UI.
- Add thinking-level fields to task/options data model, persistence, API, and UI.
- Orchestrator mapping from thinking level to execution agent.
- Backward compatibility for existing tasks/options.
- Tests for new UI/API behavior and agent selection wiring.

Out of scope:
- Modifying OpenCode built-in TUI behavior.
- Provider-specific tuning UI beyond standardized low/medium/high/default levels.

## Functional Requirements

### 1) Model Dropdowns

- Task modal must provide dropdowns for:
  - Plan model
  - Execution model
- Options modal must provide dropdowns for:
  - Global plan model
  - Global execution model
- Each dropdown includes:
  - `default`
  - Available models grouped by provider, represented as `provider/model`
- Existing saved model strings must continue to work, even if a model later disappears from provider catalog.

### 2) Thinking Level

- Add selectable thinking level at:
  - Task level (override)
  - Global options level (default)
- Allowed values:
  - `default`
  - `low`
  - `medium`
  - `high`
- Resolution rule at runtime:
  - Use task value when not `default`, otherwise use global value.
  - If resolved value is `default`, do not force an execution agent override.
  - If resolved value is concrete (`low|medium|high`), map to agent name.

## Agent Mapping Strategy

Define a deterministic mapping in orchestrator:

- `low` -> `build-fast`
- `medium` -> `build`
- `high` -> `deep-thinker`

Notes:
- Mapping should be centralized in one helper for readability and future changes.
- If mapped agent is unavailable, fail early with a clear error message that lists expected agent names.

## Data Model & Migration Plan

## Types

Update `.opencode/easy-workflow/types.ts`:

- Add `ThinkingLevel = "default" | "low" | "medium" | "high"`.
- Add `thinkingLevel: ThinkingLevel` to `Task`.
- Add `thinkingLevel: ThinkingLevel` to `Options`.

## SQLite Schema

Update `.opencode/easy-workflow/db.ts` migrations:

- `tasks` table: add `thinking_level TEXT NOT NULL DEFAULT 'default'` if missing.
- `options` table seed/upsert: add key `thinking_level` with default `default`.

Update mapping functions:

- `rowToTask`: map `thinking_level` -> `thinkingLevel`.
- `createTask`: accept and persist `thinkingLevel`.
- `updateTask`: allow `thinkingLevel` updates.
- `getOptions`/`updateOptions`: include `thinkingLevel`.

Backward compatibility:

- Existing DBs without new column/key should self-heal through migration and default values.

## Backend API Plan

Update `.opencode/easy-workflow/server.ts`:

1. Add `GET /api/models` endpoint:
   - Fetch provider catalog via SDK client `config.providers()`.
   - Return normalized payload, for example:
     - `providers: [{ id, name, models: [{ id, label, value: "provider/model" }] }]`
   - Include `default` model map if available.
   - Handle failures gracefully with actionable error text.

2. Existing endpoints `/api/tasks` and `/api/options`:
   - Accept and return `thinkingLevel`.
   - Validate `thinkingLevel` values.

3. Validation for model fields:
   - Continue allowing free-form persisted values for backward compatibility.
   - UI should prefer catalog-driven values, but backend should keep robust error handling at execution time (already done in orchestrator model resolver).

## Orchestrator Plan

Update `.opencode/easy-workflow/orchestrator.ts`:

1. Add helper to resolve effective thinking level:
   - task override -> option default -> `default`.

2. Add helper to map thinking level to execution agent.

3. Apply mapped agent to execution prompt calls:
   - Direct execution prompt.
   - Plan mode execution phase prompt.
   - (Optional) plan phase can remain `plan` agent unless explicitly changed.

4. Keep model selection logic unchanged and orthogonal:
   - Model choice still determined by task/global model values.
   - Thinking level affects agent choice.

5. Error handling:
   - If mapped agent not found, raise explicit configuration error and mark task failed with actionable remediation.

## Kanban UI Plan

Update `.opencode/easy-workflow/kanban/index.html`:

1. State additions:
   - `availableModels` / `modelCatalog` in JS runtime state.

2. Data loading:
   - Add `loadModels()` that calls `/api/models` during init.

3. Model controls:
   - Replace model text inputs with `<select>` controls in task and options modals.
   - Populate with `default` and grouped provider/model options.
   - When editing old task data with unknown model value, inject temporary option so it remains visible/selectable.

4. Thinking level controls:
   - Add `<select>` in task modal and options modal with:
     - Default, Low, Medium, High.

5. Save/load wiring:
   - Include `thinkingLevel` in task save payload and options save payload.
   - Hydrate controls from loaded task/options values.

6. Card visibility:
   - Add badge showing effective task thinking level when not default (optional but recommended for operator clarity).

## Validation Rules

- `thinkingLevel` must be one of: `default|low|medium|high`.
- Model dropdown selected value is either `default` or `provider/model`.
- Branch remains required as currently enforced.
- Existing server-side model resolution errors remain authoritative before execution.

## Testing Plan

## Automated

Update `test-kanban-web-ui.ts` (and/or add a companion test):

1. Verify `/api/models` returns a valid catalog shape.
2. Verify task modal model controls populate from catalog.
3. Create a task selecting non-default execution model and thinking level `high`.
4. Confirm task persists and reloads with same values.
5. Start execution and confirm task runs without schema/runtime errors.

## Manual smoke checks

1. Open Options modal:
   - Model dropdowns render.
   - Thinking level dropdown renders and saves.
2. Create/edit task:
   - Model dropdowns and thinking level dropdown save/reload correctly.
3. Run backlog task with each level (`low`, `medium`, `high`):
   - Confirm orchestrator chooses mapped agent path.

## Rollout Sequence

1. Types + DB migration.
2. Server API (`/api/models`) + task/options validation.
3. UI dropdown conversion and thinking-level controls.
4. Orchestrator thinking-level to agent mapping.
5. Tests and smoke validation.

## Risks and Mitigations

- Risk: mapped agent names not defined in user config.
  - Mitigation: explicit runtime validation and clear error message listing required agents.

- Risk: model catalog fetch fails intermittently.
  - Mitigation: show toast, keep form usable with `default`, and preserve previously saved values.

- Risk: stale/removed models in old tasks.
  - Mitigation: preserve unknown value in dropdown via injected option and rely on execution-time validation.

## Acceptance Criteria

- Kanban UI uses dropdowns (not text inputs) for plan/execution model selection in both task and options modals.
- Kanban UI offers thinking-level selection in task and options modals.
- Task and options persistence includes `thinkingLevel` with migration-safe defaults.
- Orchestrator maps thinking levels to configured agents and applies mapping during execution.
- Existing tasks/options continue to load and run after migration.
- Web UI test coverage includes the new controls and basic execution path.
