# Pi Extension Conversion Progress

**Branch:** `pi-extension`  
**Started:** 2026-04-05  
**Status:** In Progress (exact HTML copied; compatibility API surface expanded)

## Overview

Converting `opencode-easy-workflow` OpenCode plugin to a pi extension.

## Implementation Status

### Phase 1: Project Structure ✅
- [x] Create `pi-easy-workflow/` directory
- [x] Create `plans/` directory with conversion documentation
- [x] Create `package.json`
- [x] Create `tsconfig.json`
- [x] Create `biome.json`
- [x] Create `README.md`
- [x] Create `AGENTS.md`

### Phase 2: Core Entry Point & Config ✅
- [x] `src/index.ts` - Extension entry point
- [x] `src/config.ts` - Configuration schema and loader

### Phase 3: Kanban System ✅
- [x] `src/kanban/types.ts` - Types (adapted from OpenCode)
- [x] `src/kanban/db.ts` - Database layer (adapted, uses better-sqlite3)
- [x] `src/kanban/server.ts` - HTTP API server (now serving in-package kanban HTML)
- [x] `src/kanban/index.ts` - Re-exports
- [x] `src/kanban/orchestrator.ts` - Initial task state machine implemented
- [ ] `src/kanban/task-state.ts` - Task state (NOT COPIED - simplify)
- [ ] `src/kanban/execution-plan.ts` - Execution planning (NOT COPIED - simplify)

### Phase 4: Hooks ✅
- [x] `src/hooks/index.ts` - Hook registration
- [x] `src/hooks/input.ts` - `#workflow` prefix handling
- [x] `src/hooks/tool-call.ts` - Review orchestration & permissions
- [x] `src/hooks/before-agent-start.ts` - System prompt injection
- [x] `src/hooks/session.ts` - Session lifecycle

### Phase 5: Tools ✅
- [x] `src/tools/index.ts` - Tool registration
- [x] `src/tools/workflow-tools.ts` - Main workflow tools wired to DB/orchestrator
- [x] `src/tools/kanban-tools.ts` - Kanban CRUD tools (stubs)

### Phase 6: Commands ✅
- [x] `src/commands/index.ts` - Command registration
- [x] `src/commands/board.ts` - Kanban board command
- [x] `src/commands/workflow.ts` - Workflow management
- [x] `src/commands/task.ts` - Task CRUD/start/approve commands wired to DB/orchestrator

### Phase 7: Utilities ✅
- [x] `src/utils/workflow-parser.ts` - `#workflow` parsing
- [x] `src/utils/run-state.ts` - Run file state management
- [x] `src/utils/review.ts` - Initial review logic implemented
- [ ] `src/utils/goals.ts` - Goal extraction (merged into review.ts)

### Phase 8: Prompts ✅
- [x] `src/prompts/workflow-review.md`
- [x] `src/prompts/workflow-plan.md`
- [x] `src/prompts/workflow-build.md`
- [x] `src/prompts/workflow-build-fast.md`
- [x] `src/prompts/workflow-deep-thinker.md`
- [x] `src/prompts/workflow-review-autonomous.md`
- [x] `src/prompts/workflow-repair.md`

### Phase 9: Skills ✅
- [x] `src/skills/workflow-task-setup/SKILL.md`

### Phase 10: Testing & Polish 🔄
- [x] TypeScript type checking
- [ ] Biome linting
- [ ] Fix any compilation errors
- [ ] Manual testing in Interactive mode
- [ ] Manual testing in RPC mode
- [ ] Manual testing in Print mode

## Current Implementation Notes

### Entry Point Pattern (src/index.ts)
```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { configLoader } from "./config";
import { registerTools } from "./tools";
import { registerCommands } from "./commands";
import { registerHooks } from "./hooks";

export default async function (pi: ExtensionAPI) {
  await configLoader.load();
  const config = configLoader.getConfig();
  if (!config.enabled) return;

  registerTools(pi);
  registerCommands(pi);
  registerHooks(pi);
}
```

### Key API Mappings Used
- `client.session.prompt()` → Use tools or prompt injection
- `client.app.log()` → `pi.logger.info()`
- `client.tui.showToast()` → `ctx.ui.notify()`
- `chat.message` → `input` hook
- `session.idle` → `before_agent_start` hook
- `permission.asked` → `tool_call` hook

## Blockers / Open Questions

1. **Orchestrator session creation**: How to create sub-sessions in pi? **Status: RESOLVED** — Use `createAgentSession()` from `@mariozechner/pi-coding-agent` with `SessionManager.inMemory()`. See the [Orchestrator Design](plans/orchestrator-design.md) document for full details. The `pi-subagents` package (tintinweb) proves this pattern works in production.
2. **Permission system**: Pi's permission model differs from OpenCode. **Status: RESOLVED** — Pi has no built-in permission gate. Use `tool_call` hook to intercept and auto-allow tools for workflow-owned sessions. Set `skip_permission_asking` flag in `workflow_sessions` DB table. The `tool_call` hook returns `undefined` (no block) for workflow-owned sessions, effectively bypassing all permission prompts. See [Orchestrator Design](plans/orchestrator-design.md).
3. **HTTP server**: Kept simplified version. Works but may conflict with pi's port usage. **Status: WORKS**
4. **Kanban orchestrator**: **Status: PARTIALLY IMPLEMENTED** — Added a first-pass state machine in `src/kanban/orchestrator.ts` and wired task/workflow entry points to it. Still needs the full sub-session execution flow from [Orchestrator Design](plans/orchestrator-design.md).

## File Dependencies

```
src/index.ts
├── src/config.ts ✅
├── src/hooks/index.ts ✅
│   ├── src/hooks/input.ts ✅
│   ├── src/hooks/tool-call.ts ✅
│   ├── src/hooks/before-agent-start.ts ✅
│   └── src/hooks/session.ts ✅
├── src/tools/index.ts ✅
│   ├── src/tools/workflow-tools.ts ✅
│   └── src/tools/kanban-tools.ts ✅
└── src/commands/index.ts ✅
    ├── src/commands/board.ts ✅
    ├── src/commands/workflow.ts ✅
    └── src/commands/task.ts ✅

src/kanban/ (standalone dependencies)
├── src/kanban/db.ts ✅
├── src/kanban/server.ts ✅
├── src/kanban/types.ts ✅
├── src/kanban/index.ts ✅
└── src/kanban/index.html ✅

⚠️ Missing/Partial:
├── src/kanban/orchestrator.ts (initial implementation; sub-session execution still pending)
├── src/utils/review.ts (heuristic implementation; real scratch-review flow still pending)
├── src/utils/run-state.ts (partial)
```

## Next Steps

1. **Manual/UI validation**: load the copied kanban page through the extension server and exercise create/edit/delete/start/approve/revision/repair flows to catch any remaining behavioral mismatches
2. **Deepen orchestrator**: replace the current DB-only transitions with real sub-session execution
3. **Review persistence**: store/update pending review state and run results from hooks
4. **Lint + polish**: run `npm run lint` and clean up any remaining issues
5. **Test**: run integration tests and then try loading the extension in pi

## Files Created

```
pi-easy-workflow/
├── package.json ✅
├── tsconfig.json ✅
├── biome.json ✅
├── README.md ✅
├── AGENTS.md ✅
├── PROGRESS.md ✅
└── src/
    ├── index.ts ✅
    ├── config.ts ✅
    ├── hooks/
    │   ├── index.ts ✅
    │   ├── input.ts ✅
    │   ├── tool-call.ts ✅
    │   ├── before-agent-start.ts ✅
    │   └── session.ts ✅
    ├── tools/
    │   ├── index.ts ✅
    │   ├── workflow-tools.ts ✅
    │   └── kanban-tools.ts ✅
    ├── commands/
    │   ├── index.ts ✅
    │   ├── board.ts ✅
    │   ├── workflow.ts ✅
    │   └── task.ts ✅
    ├── utils/
    │   ├── workflow-parser.ts ✅
    │   ├── run-state.ts ✅
    │   └── review.ts ✅
    ├── kanban/
    │   ├── index.ts ✅
    │   ├── types.ts ✅
    │   ├── db.ts ✅
    │   └── server.ts ✅
    ├── prompts/
    │   ├── workflow-review.md ✅
    │   ├── workflow-plan.md ✅
    │   ├── workflow-build.md ✅
    │   ├── workflow-build-fast.md ✅
    │   ├── workflow-deep-thinker.md ✅
    │   ├── workflow-review-autonomous.md ✅
    │   └── workflow-repair.md ✅
    └── skills/
        └── workflow-task-setup/
            └── SKILL.md ✅
```

**Total: 32 files created**

## Latest Progress Log

- 2026-04-05: Confirmed the local package install state was blocking meaningful type-checking (`node_modules` missing entirely), installed dependencies, added `better-sqlite3`, and got `npm run typecheck` passing.
- 2026-04-05: Copied `.opencode/easy-workflow/kanban/index.html` verbatim into `pi-easy-workflow/src/kanban/index.html` so the page is now available from inside the Pi extension directory with exact visual/functional parity target.
- 2026-04-05: Expanded `src/kanban/server.ts` to serve the copied page plus a broader compatibility API surface expected by the original UI (`/api/models`, `/api/branches`, `/api/start`, `/api/stop`, `/api/execution-graph`, task start/repair/revision endpoints, runs/candidates/summary endpoints, and `/ws`).
- 2026-04-05: Performed a parity pass against the copied kanban HTML and tightened server behavior to better match the original OpenCode server: restored old-style validation/error cases, fixed `/api/start` and task-start behavior, returned `204` for deletes, accepted old reorder payloads, added plan approval/revision semantics, and aligned execution graph + best-of-n summary response shapes more closely with the legacy page.
- 2026-04-05: Fixed core kanban type mismatches in `src/kanban/types.ts` (`Task`, `WorkflowSessionKind`, `RunPhase`, `RunStatus`, `Options`, `plan_revision_pending`, and missing task fields).
- 2026-04-05: Updated `src/kanban/db.ts` to persist the newly required task fields and reuse `WorkflowSessionKind` from shared types.
- 2026-04-05: Added `src/kanban/orchestrator.ts` with an initial task lifecycle state machine and `src/kanban/runtime.ts` for shared DB/orchestrator access.
- 2026-04-05: Wired orchestrator usage into `src/tools/workflow-tools.ts` and `src/commands/task.ts`.
- 2026-04-05: Aligned extension code with the actual Pi SDK typings (`@mariozechner/pi-ai` schemas, `input` hook return shape, required tool labels, and removal of incompatible render helpers).
- 2026-04-05: Implemented `getWorkflowSessionOwner()` in `src/hooks/tool-call.ts` using the kanban DB workflow session table.
- 2026-04-05: Replaced `src/utils/review.ts` placeholders with a first-pass pending-review detector, heuristic review runner, and goal extraction.

## How to Continue

To continue this work:

1. Run `pnpm typecheck` in `pi-easy-workflow/` directory
2. Fix any TypeScript errors
3. Implement the stubbed functions in:
   - `src/utils/review.ts` - review logic
   - `src/tools/workflow-tools.ts` - workflow_start, workflow_status, etc.
   - `src/commands/*.ts` - command handlers
4. Test the extension by placing it in `~/.pi/extensions/` or using `PI_EXTENSIONS_DIR`
