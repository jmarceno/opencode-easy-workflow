# Pi Extension Conversion Progress

**Branch:** `pi-extension`  
**Started:** 2026-04-05  
**Status:** In Progress (Core structure complete)

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
- [x] `src/kanban/server.ts` - HTTP API server (simplified)
- [x] `src/kanban/index.ts` - Re-exports
- [ ] `src/kanban/orchestrator.ts` - Task orchestration (STUB NEEDED)
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
- [x] `src/tools/workflow-tools.ts` - Main workflow tools (stubs)
- [x] `src/tools/kanban-tools.ts` - Kanban CRUD tools (stubs)

### Phase 6: Commands ✅
- [x] `src/commands/index.ts` - Command registration
- [x] `src/commands/board.ts` - Kanban board command
- [x] `src/commands/workflow.ts` - Workflow management
- [x] `src/commands/task.ts` - Task CRUD commands

### Phase 7: Utilities ✅
- [x] `src/utils/workflow-parser.ts` - `#workflow` parsing
- [x] `src/utils/run-state.ts` - Run file state management
- [x] `src/utils/review.ts` - Review logic (stubs)
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
- [ ] TypeScript type checking
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

1. **Orchestrator session creation**: How to create sub-sessions in pi? Need to investigate `pi.createSession()` vs other approaches. **Status: NOT YET INVESTIGATED**
2. **Permission system**: Pi's permission model differs from OpenCode. `tool_call` hook handles blocking, but auto-reply needs more work. **Status: PARTIAL**
3. **HTTP server**: Kept simplified version. Works but may conflict with pi's port usage. **Status: WORKS**
4. **Kanban orchestrator**: Original orchestrator.ts was complex with OpenCode session management. Simplified to stubs. **Status: NEEDS IMPLEMENTATION**

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
└── src/kanban/index.ts ✅

⚠️ Missing/Stubbed:
├── src/kanban/orchestrator.ts (stub)
├── src/utils/review.ts (stub)
├── src/utils/run-state.ts (partial)
```

## Next Steps

1. **Type check**: Run `pnpm typecheck` and fix errors
2. **Linting**: Run `pnpm lint` and fix issues
3. **Implement stubs**: Fill in kanban orchestrator and review logic
4. **Test**: Try loading the extension in pi

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

**Total: 31 files created**

## How to Continue

To continue this work:

1. Run `pnpm typecheck` in `pi-easy-workflow/` directory
2. Fix any TypeScript errors
3. Implement the stubbed functions in:
   - `src/utils/review.ts` - review logic
   - `src/tools/workflow-tools.ts` - workflow_start, workflow_status, etc.
   - `src/commands/*.ts` - command handlers
4. Test the extension by placing it in `~/.pi/extensions/` or using `PI_EXTENSIONS_DIR`
