# Pi Extension Conversion Plan Summary

**Repository:** opencode-easy-workflow  
**Target:** Convert from OpenCode plugin to pi extension  
**Branch:** `pi-extension`

---

## What This Extension Does

The Easy Workflow extension provides a review-driven development workflow with:

1. **Kanban Board** - Visual task management via HTTP server
2. **Workflow Sessions** - Structured task execution with `#workflow` prefix
3. **Review Loop** - Automatic review after task completion
4. **Multi-Agent Support** - Plan, build, review, and repair agents
5. **Git Worktree Integration** - Isolated branches per task

---

## Key Differences: OpenCode vs Pi

| Aspect | OpenCode Plugin | Pi Extension |
|--------|-----------------|--------------|
| SDK | `@opencode-ai/sdk` | `@mariozechner/pi-coding-agent` |
| Event Model | `chat.message`, `event` | `input`, `tool_call`, `session_start`, etc. |
| Hook Pattern | Single export with event routing | `pi.on(event, handler)` |
| Tools | Built-in via SDK | `pi.registerTool()` |
| Commands | Not used | `pi.registerCommand()` |
| Config | OpenCode config | `@aliou/pi-utils-settings` |

---

## Conversion Phases

### Phase 1: Project Setup
- Create `pi-easy-workflow/` directory structure
- Set up `package.json`, `tsconfig.json`, `biome.json`
- Configure `pi` field for extensions, skills, prompts

### Phase 2: Entry Point & Config
- Rewrite main plugin as `src/index.ts`
- Add `src/config.ts` for settings

### Phase 3: Kanban System (Minimal Changes)
- Copy and adapt database layer
- Adapt HTTP server for pi's execution model
- Adapt orchestrator for pi's session management

### Phase 4: Hooks (Event System)
- `input` hook → `#workflow` prefix detection
- `before_agent_start` → review injection
- `tool_call` → workflow-owned session handling

### Phase 5: Tools & Commands
- Register workflow tools: `workflow_start`, `workflow_status`, `workflow_review`
- Register kanban tools: `kanban_list`, `kanban_create`, `kanban_update`, `kanban_delete`
- Register commands: `/board`, `/workflow`, `/task`

### Phase 6: Prompts & Skills
- Convert OpenCode agents to pi prompt format
- Adapt task setup skill for pi

---

## Files to Create

See [file-conversion-checklist.md](file-conversion-checklist.md) for complete list.

**New structure:**
```
pi-easy-workflow/
├── src/
│   ├── index.ts              # Entry point
│   ├── config.ts             # Configuration
│   ├── kanban/               # Kanban system (adapted)
│   ├── tools/                # LLM-callable tools
│   ├── commands/             # User commands
│   ├── hooks/                # Event hooks
│   ├── components/           # TUI components
│   ├── prompts/              # Agent prompts
│   ├── skills/               # Skills
│   └── utils/                # Utilities
├── package.json
├── tsconfig.json
└── biome.json
```

---

## Testing Requirements

1. **Interactive Mode** - Full TUI with commands
2. **RPC Mode** - JSON protocol with host
3. **Print Mode** - No-UI operation

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Session model differs | Redesign review flow |
| No subagent concept | Use inline prompts or tools |
| HTTP server conflicts | Configurable ports |
| Tool naming conflicts | Use `workflow_` prefix |

---

## References

- Full plan: [pi-extension-conversion-plan.md](pi-extension-conversion-plan.md)
- File checklist: [file-conversion-checklist.md](file-conversion-checklist.md)
- Pi extension docs: `/home/jmarceno/.nvm/versions/node/v25.7.0/lib/node_modules/@aliou/pi-extension-dev/src/skills/pi-extension/`
