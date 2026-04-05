# Easy Workflow Extension - Agent Guidelines

This extension provides review-driven workflow capabilities for pi. This document describes implementation decisions and patterns for developers working on this extension.

## Entry Point Pattern

The extension follows the standard pi entry point pattern:

```typescript
export default async function (pi: ExtensionAPI) {
  await configLoader.load();
  const config = configLoader.getConfig();
  if (!config.enabled) return;

  registerTools(pi);
  registerCommands(pi);
  registerHooks(pi);
}
```

**Deviation from standard pattern:** This extension always uses the config loader pattern (no API-key-first deviation) because it doesn't wrap a third-party API.

## Key Implementation Decisions

### 1. Kanban System Adaptation

The kanban system was adapted from the OpenCode plugin:

- Uses `better-sqlite3` instead of `bun:sqlite` for compatibility
- HTTP server provides REST API for task management
- Workflow sessions are tracked in SQLite for permission auto-reply

### 2. Review Flow Architecture

The review flow in pi differs from OpenCode:

**OpenCode approach:**
- Creates scratch sessions for sub-agents
- Uses `session.prompt()` to route to review agents
- Tracks workflow runs in markdown files

**pi approach:**
- Uses `before_agent_start` hook to inject review context
- Review is integrated into the main session turn
- Workflow state tracked in session context

**Current status:** The review integration is stubbed. Full implementation requires:
1. Workflow run state management in session context
2. Integration with the kanban task model
3. Review context injection via `before_agent_start`

### 3. Permission Auto-Reply

**Current approach:** The `tool_call` hook checks for workflow-owned sessions before allowing tool execution.

**Limitation:** pi's permission model differs from OpenCode. The `permission.asked` event doesn't exist in pi. Permission handling needs to be done via:
- `tool_call` blocking
- Configuration in task definitions
- Session kind-based allowlists

### 4. Session Management

**Challenge:** pi doesn't have a direct equivalent to OpenCode's `client.session.create()` for creating sub-sessions.

**Options considered:**
1. Use tools to execute prompts in the current session
2. Use pi's built-in task execution (if available)
3. Fork sessions via `session_fork` event

**Current implementation:** Stubs only. Full session management requires more investigation.

## File Organization

```
src/
├── index.ts           # Entry point
├── config.ts          # Config schema + loader
├── hooks/             # Event hooks
│   ├── index.ts       # Registers all hooks
│   ├── input.ts       # #workflow prefix detection
│   ├── tool-call.ts   # Review orchestration
│   ├── before-agent-start.ts  # Review injection
│   └── session.ts     # Session lifecycle
├── tools/             # LLM-callable tools
│   ├── index.ts       # Registers all tools
│   ├── workflow-tools.ts   # workflow_start, workflow_status, etc.
│   └── kanban-tools.ts     # kanban_list, kanban_create, etc.
├── commands/          # User commands
│   ├── index.ts       # Registers all commands
│   ├── board.ts       # /board
│   ├── workflow.ts    # /workflow
│   └── task.ts        # /task
├── kanban/            # Kanban system (adapted from OpenCode)
│   ├── db.ts          # SQLite database
│   ├── server.ts      # HTTP API
│   ├── types.ts       # TypeScript types
│   └── index.ts       # Re-exports
├── prompts/           # Agent prompts
└── skills/            # Skills
```

## Open Questions

1. **Session creation:** How to create sub-sessions in pi for parallel review/building?
2. **Permission model:** How to implement workflow-owned session permissions in pi?
3. **HTTP server:** Should we keep the HTTP server or integrate with pi's RPC?

## Testing

Test in three modes:
1. **Interactive:** Full TUI, commands work
2. **RPC:** JSON protocol, host handles UI
3. **Print:** No UI, background execution

## References

- [Pi Extension Dev Skill](../.pi/agent/skills/pi-extension/)
- [Extension Structure Reference](src/skills/pi-extension/references/structure.md)
- [Tools Reference](src/skills/pi-extension/references/tools.md)
- [Hooks Reference](src/skills/pi-extension/references/hooks.md)
- [Commands Reference](src/skills/pi-extension/references/commands.md)
