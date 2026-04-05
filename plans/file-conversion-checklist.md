# File Conversion Checklist

## New Files to Create

### Core Extension Files
- [ ] `pi-easy-workflow/package.json` - NPM package config for pi extension
- [ ] `pi-easy-workflow/tsconfig.json` - TypeScript configuration
- [ ] `pi-easy-workflow/biome.json` - Biome linting/formatting
- [ ] `pi-easy-workflow/README.md` - Extension documentation
- [ ] `pi-easy-workflow/AGENTS.md` - Extension-specific agent guidelines
- [ ] `pi-easy-workflow/src/index.ts` - Extension entry point

### Configuration
- [ ] `pi-easy-workflow/src/config.ts` - Config schema and loader

### Kanban System (adapted)
- [ ] `pi-easy-workflow/src/kanban/db.ts` - Database layer (copy + adapt imports)
- [ ] `pi-easy-workflow/src/kanban/server.ts` - HTTP API server (adapt)
- [ ] `pi-easy-workflow/src/kanban/orchestrator.ts` - Task orchestration (major adapt)
- [ ] `pi-easy-workflow/src/kanban/types.ts` - Types (keep mostly)
- [ ] `pi-easy-workflow/src/kanban/task-state.ts` - Task state (keep)
- [ ] `pi-easy-workflow/src/kanban/execution-plan.ts` - Execution planning (keep)
- [ ] `pi-easy-workflow/src/kanban/index.ts` - Re-export

### Tools
- [ ] `pi-easy-workflow/src/tools/workflow-tools.ts` - Main workflow tools
- [ ] `pi-easy-workflow/src/tools/kanban-tools.ts` - Kanban CRUD tools

### Commands
- [ ] `pi-easy-workflow/src/commands/board.ts` - Kanban board command
- [ ] `pi-easy-workflow/src/commands/workflow.ts` - Workflow management
- [ ] `pi-easy-workflow/src/commands/task.ts` - Task CRUD commands

### Hooks
- [ ] `pi-easy-workflow/src/hooks/index.ts` - Hook registration
- [ ] `pi-easy-workflow/src/hooks/input.ts` - `#workflow` prefix handling
- [ ] `pi-easy-workflow/src/hooks/tool-call.ts` - Review orchestration
- [ ] `pi-easy-workflow/src/hooks/before-agent-start.ts` - System prompt injection
- [ ] `pi-easy-workflow/src/hooks/session.ts` - Session lifecycle

### Components
- [ ] `pi-easy-workflow/src/components/board-display.ts` - Kanban TUI component

### Prompts
- [ ] `pi-easy-workflow/src/prompts/workflow-review.md`
- [ ] `pi-easy-workflow/src/prompts/workflow-plan.md`
- [ ] `pi-easy-workflow/src/prompts/workflow-build.md`
- [ ] `pi-easy-workflow/src/prompts/workflow-build-fast.md`
- [ ] `pi-easy-workflow/src/prompts/workflow-deep-thinker.md`
- [ ] `pi-easy-workflow/src/prompts/workflow-review-autonomous.md`
- [ ] `pi-easy-workflow/src/prompts/workflow-repair.md`

### Skills
- [ ] `pi-easy-workflow/src/skills/workflow-task-setup/SKILL.md`

### Utilities
- [ ] `pi-easy-workflow/src/utils/workflow-parser.ts` - `#workflow` parsing
- [ ] `pi-easy-workflow/src/utils/run-state.ts` - Run file state
- [ ] `pi-easy-workflow/src/utils/review.ts` - Review logic
- [ ] `pi-easy-workflow/src/utils/goals.ts` - Goal extraction

---

## Files to Copy/Adapt (from OpenCode plugin)

| Original File | Target File | Adaptation Needed |
|---------------|-------------|-------------------|
| `.opencode/plugins/easy-workflow.ts` | `src/index.ts` | Major rewrite |
| `.opencode/easy-workflow/db.ts` | `src/kanban/db.ts` | Minor (imports) |
| `.opencode/easy-workflow/server.ts` | `src/kanban/server.ts` | Moderate (session APIs) |
| `.opencode/easy-workflow/orchestrator.ts` | `src/kanban/orchestrator.ts` | Major (session creation) |
| `.opencode/easy-workflow/types.ts` | `src/kanban/types.ts` | Minor |
| `.opencode/easy-workflow/task-state.ts` | `src/kanban/task-state.ts` | None |
| `.opencode/easy-workflow/execution-plan.ts` | `src/kanban/execution-plan.ts` | None |
| `.opencode/easy-workflow/workflow.md` | `src/prompts/workflow-review.md` | Convert format |
| `.opencode/agents/workflow-review.md` | `src/prompts/workflow-review.md` | Adapt format |
| `.opencode/agents/workflow-plan.md` | `src/prompts/workflow-plan.md` | Adapt format |
| `.opencode/agents/workflow-build.md` | `src/prompts/workflow-build.md` | Adapt format |
| `.opencode/agents/workflow-build-fast.md` | `src/prompts/workflow-build-fast.md` | Adapt format |
| `.opencode/agents/workflow-deep-thinker.md` | `src/prompts/workflow-deep-thinker.md` | Adapt format |
| `.opencode/agents/workflow-review-autonomous.md` | `src/prompts/workflow-review-autonomous.md` | Adapt format |
| `.opencode/agents/workflow-repair.md` | `src/prompts/workflow-repair.md` | Adapt format |
| `.opencode/skills/workflow-task-setup/SKILL.md` | `src/skills/workflow-task-setup/SKILL.md` | Minor adapt |

---

## Files to Keep (Shared Resources)

| File | Purpose |
|------|---------|
| `ref-docs/opencode.ai-*.md` | Reference documentation |
| `plans/*.md` | This plan and future plans |

---

## Files to Deprecate (OpenCode-specific, not needed in pi)

| File | Reason |
|------|--------|
| `.opencode/plugins/easy-workflow.ts` | Replaced by `src/index.ts` |
| `.opencode/easy-workflow/workflow.md` | Replaced by `src/prompts/*.md` |
| `.opencode/agents/*.md` | Replaced by `src/prompts/*.md` |
| `.opencode/skills/workflow-task-setup/SKILL.md` | Replaced by `src/skills/...` |
| `test-workflow.ts` | OpenCode-specific tests |

---

## Implementation Priority

### Priority 1: Core Infrastructure
1. `package.json`, `tsconfig.json`, `biome.json`
2. `src/index.ts` - Basic structure
3. `src/config.ts` - Configuration

### Priority 2: Kanban System
4. Copy `db.ts`, `types.ts`, `task-state.ts`, `execution-plan.ts`
5. Adapt `server.ts` for pi
6. Adapt `orchestrator.ts` for pi

### Priority 3: Hooks & Integration
7. `src/hooks/input.ts` - `#workflow` detection
8. `src/hooks/tool-call.ts` - Review triggers
9. `src/hooks/before-agent-start.ts` - System prompt

### Priority 4: Tools & Commands
10. `src/tools/workflow-tools.ts` - Core workflow tools
11. `src/commands/board.ts` - Board display
12. `src/commands/workflow.ts` - Workflow management

### Priority 5: Prompts & Skills
13. Convert all agent prompts to pi format
14. Adapt task setup skill

### Priority 6: Polish & Testing
15. Add TUI components
16. Add utilities
17. Write tests
18. Documentation
