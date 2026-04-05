# OpenCode Plugin to Pi Extension Conversion Plan

## Overview

This document outlines the conversion of the `opencode-easy-workflow` repository from an OpenCode plugin to a pi extension.

**Current State:**
- OpenCode plugin providing review-driven workflow with kanban board
- Uses OpenCode SDK v2 (`@opencode-ai/sdk`)
- Hooks into `chat.message`, `event` (session.idle, permission.asked)
- Includes kanban system (db.ts, server.ts, orchestrator.ts)

**Target State:**
- Pi extension using pi-coding-agent SDK
- Hooks into pi events (`tool_call`, `session_start`, `before_agent_start`, `input`, etc.)
- Same kanban functionality, adapted for pi's extension API

---

## Phase 1: Project Structure Setup

### 1.1 Create Pi Extension Directory Structure

```
pi-easy-workflow/
├── src/
│   ├── index.ts                    # Entry point (default export)
│   ├── config.ts                   # Config schema + loader
│   ├── client.ts                   # (keep existing kanban logic)
│   ├── tools/
│   │   └── workflow-tools.ts       # LLM-callable tools
│   ├── commands/
│   │   ├── board.ts                # Show/open kanban board command
│   │   ├── workflow.ts             # Workflow management commands
│   │   └── task.ts                 # Task CRUD commands
│   ├── hooks/
│   │   ├── input.ts                # #workflow prefix handling
│   │   ├── tool-call.ts             # Review orchestration
│   │   ├── before-agent-start.ts   # System prompt injection
│   │   └── session.ts              # Session lifecycle hooks
│   ├── components/
│   │   └── board-display.ts        # Kanban TUI component
│   ├── providers/
│   │   └── index.ts                # (if needed for custom models)
│   └── utils/
│       ├── workflow-parser.ts       # #workflow prompt parsing
│       ├── run-state.ts             # Run file state management
│       └── review.ts                # Review logic
│   ├── kanban/
│   │   ├── db.ts                   # SQLite database layer (keep)
│   │   ├── server.ts               # HTTP API server (adapt)
│   │   ├── orchestrator.ts         # Task orchestration (adapt)
│   │   ├── types.ts                # Types (keep)
│   │   ├── task-state.ts           # Task state (keep)
│   │   └── execution-plan.ts       # Execution planning (keep)
│   ├── prompts/
│   │   ├── workflow-review.md      # Review prompt template
│   │   ├── workflow-plan.md        # Plan prompt template
│   │   ├── workflow-build.md       # Build prompt template
│   │   └── workflow-repair.md      # Repair prompt template
│   └── skills/
│       └── workflow-task-setup/
│           └── SKILL.md            # Task setup skill (adapt)
├── package.json
├── tsconfig.json
├── biome.json
├── README.md
└── AGENTS.md
```

### 1.2 Required Package.json Fields

```json
{
  "name": "@your-org/pi-easy-workflow",
  "version": "0.1.0",
  "description": "Review-driven workflow with kanban board for pi",
  "type": "module",
  "pi": {
    "extensions": ["./src/index.ts"],
    "skills": ["./src/skills"],
    "prompts": ["./src/prompts"]
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": ">=CURRENT_VERSION",
    "@mariozechner/pi-tui": ">=CURRENT_VERSION"
  }
}
```

---

## Phase 2: Core Component Conversion

### 2.1 Entry Point (src/index.ts)

**OpenCode Pattern:**
```typescript
export const EasyWorkflowPlugin = async (input: any) => {
  const { client, directory } = input;
  // ...
  return {
    "chat.message": async (input, output) => { /* ... */ },
    "event": async ({ event }) => { /* ... */ },
  };
};
```

**Pi Pattern:**
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

**Key Changes:**
- Replace OpenCode SDK client with pi `ExtensionAPI`
- Convert `chat.message` hook → `input` hook for `#workflow` detection
- Convert `event` hook → individual session/tool hooks
- Remove direct API calls, use pi's ExtensionAPI methods

### 2.2 Configuration (src/config.ts)

**Current:** No config file exists (uses OpenCode's config system)

**New:**
```typescript
import { ConfigLoader } from "@aliou/pi-utils-settings";

export interface EasyWorkflowConfig {
  enabled?: boolean;
  reviewAgent?: string;
  maxReviewRuns?: number;
  reviewCooldownMs?: number;
  port?: number;
  // ... other settings
}

export interface ResolvedConfig {
  enabled: boolean;
  reviewAgent: string;
  maxReviewRuns: number;
  reviewCooldownMs: number;
  port: number;
}

const DEFAULTS: ResolvedConfig = {
  enabled: true,
  reviewAgent: "workflow-review",
  maxReviewRuns: 2,
  reviewCooldownMs: 30_000,
  port: 3847,
};

export const configLoader = new ConfigLoader<EasyWorkflowConfig, ResolvedConfig>(
  "easy-workflow",
  DEFAULTS
);
```

---

## Phase 3: Kanban System Adaptation

### 3.1 Database Layer (src/kanban/db.ts)

**Keep as-is:** The SQLite database layer is framework-agnostic.

**Required Changes:**
- Update import paths
- Ensure compatible with pi's file system APIs
- Consider using pi's SDK helpers for paths (`getAgentDir()`, etc.)

### 3.2 HTTP Server (src/kanban/server.ts)

**Current:** Express-like HTTP server running in OpenCode plugin

**Adaptation Options:**

| Option | Pros | Cons |
|--------|------|------|
| Keep as HTTP server | Minimal changes | Port conflicts, extra process |
| Convert to WebSocket | Unified event system | More complex |
| Integrate with pi's RPC | Native to pi | Different event model |

**Recommendation:** Keep HTTP server but adapt to use pi's `pi.exec()` for process management and add graceful shutdown handling via `session_shutdown` hook.

### 3.3 Orchestrator (src/kanban/orchestrator.ts)

**Current:** Creates OpenCode sessions, prompts review agents

**Pi Adaptation:**
```typescript
// Instead of OpenCode session creation:
await client.session.prompt({ sessionID, agent, parts })

// Use pi's execution system:
// Option 1: Use pi's built-in task execution
// Option 2: Create sub-sessions via ExtensionAPI
// Option 3: Execute prompts inline with current session
```

---

## Phase 4: Hooks Conversion

### 4.1 Input Hook (#workflow prefix)

**OpenCode:**
```typescript
"chat.message": async (input, output) => {
  const textPart = getUserTextPart(output);
  const { valid, cleanedPrompt } = parseWorkflowPrompt(textPart?.text ?? "");
  if (valid) {
    textPart.text = cleanedPrompt;
    // activation logic
  }
}
```

**Pi:**
```typescript
pi.on("input", async (event, ctx) => {
  const { valid, cleanedPrompt } = parseWorkflowPrompt(event.text);
  if (valid) {
    // Create workflow run, extract goals
    await activateWorkflow(cleanedPrompt, ctx);
    return undefined; // Don't transform input
  }
  return undefined;
});
```

### 4.2 Tool Call Hook (Review Orchestration)

**OpenCode:**
```typescript
"event": async ({ event }) => {
  if (event?.type === "session.idle") {
    const activeRun = findActiveRunForSession(sessionId);
    if (activeRun) {
      const result = await runReview(client, sessionId, runPath, runFile);
      // handle result
    }
  }
}
```

**Pi:**
```typescript
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName === "bash" || event.toolName === "read" || event.toolName === "edit") {
    const activeRun = await findActiveRunForCurrentSession(ctx);
    if (activeRun && shouldRunReview(activeRun.state)) {
      // Trigger review in next agent turn
      ctx.ui.notify("Review will run after this task completes", "info");
    }
  }
  return undefined;
});

// Also hook into before_agent_start to inject review context
pi.on("before_agent_start", async (event, ctx) => {
  const activeRun = await findPendingReview(ctx);
  if (activeRun) {
    const reviewResult = await runReview(activeRun, ctx);
    // Append review context to system prompt or store results
  }
});
```

### 4.3 Permission Auto-Reply

**OpenCode:**
```typescript
if (event?.type === "permission.asked") {
  await handlePermissionAutoReply(event, client, rootDb);
}
```

**Pi:**
```typescript
// Pi doesn't have permission.asked in the same way
// Instead, use tool_call blocking or configuration
pi.on("tool_call", async (event, ctx) => {
  // For workflow-owned sessions, auto-approve certain tools
  const sessionOwner = await getWorkflowSessionOwner(ctx);
  if (sessionOwner?.skipPermissionAsking) {
    // Check if this tool is allowed for this session type
    if (isAllowedTool(event.toolName, sessionOwner.sessionKind)) {
      // Tool is auto-approved for this workflow session
      return undefined;
    }
  }
  return undefined;
});
```

---

## Phase 5: Tools Registration

### 5.1 New Tools for pi

| Tool Name | Purpose | Parameters |
|-----------|---------|------------|
| `workflow_start` | Start a workflow run | `{ prompt: string, reviewAgent?: string }` |
| `workflow_status` | Get current workflow status | `{}` |
| `workflow_review` | Manually trigger review | `{ runId?: string }` |
| `workflow_cancel` | Cancel a running workflow | `{ runId: string }` |
| `kanban_list` | List all tasks | `{ status?: string }` |
| `kanban_create` | Create a task | `{ name, prompt, ... }` |
| `kanban_update` | Update a task | `{ id, ...changes }` |
| `kanban_delete` | Delete a task | `{ id: string }` |

### 5.2 Tool Definition Pattern

```typescript
import { Type } from "@mariozechner/pi-coding-agent";

const workflowStartTool: ToolDefinition = {
  name: "workflow_start",
  description: "Start a new review-driven workflow session",
  parameters: Type.Object({
    prompt: Type.String({ description: "The task to accomplish" }),
    reviewAgent: Type.Optional(Type.String({ 
      description: "Override review agent name",
      default: "workflow-review"
    })),
  }),
  execute: async (toolCallId, params, signal, onUpdate, ctx) => {
    // Implementation
    return {
      content: [{ type: "text", text: "Workflow started..." }],
      details: { runId, status },
    };
  },
  renderCall: (params, theme) => { /* ... */ },
  renderResult: (result, options, theme) => { /* ... */ },
};
```

---

## Phase 6: Commands Registration

### 6.1 Kanban Board Command

```typescript
pi.registerCommand("board", {
  description: "Show the workflow kanban board",
  handler: async (args, ctx) => {
    const tasks = await fetchTasks();
    
    // Print mode
    if (!ctx.hasUI) {
      console.log(formatTasksPlain(tasks));
      return;
    }
    
    // Interactive mode
    const result = await ctx.ui.custom<"closed">((tui, theme, kb, done) => {
      return new KanbanBoard(theme, tasks, done);
    });
    
    // RPC fallback
    if (result === undefined) {
      ctx.ui.notify(formatTasksPlain(tasks), "info");
    }
  },
});
```

### 6.2 Workflow Commands

```typescript
pi.registerCommand("workflow", {
  description: "Manage workflow runs",
  handler: async (args, ctx) => {
    const [action, ...rest] = args.trim().split(/\s+/);
    
    switch (action) {
      case "status":
        await showWorkflowStatus(ctx);
        break;
      case "cancel":
        await cancelWorkflow(rest.join(" "), ctx);
        break;
      default:
        ctx.ui.notify("Usage: /workflow [status|cancel]", "info");
    }
  },
});
```

---

## Phase 7: Agents/Prompts Conversion

### 7.1 OpenCode Agents → Pi Prompts

**Current OpenCode Agent Format:**
```markdown
---
description: Reviews the current repository against workflow run goals
mode: subagent
model: opencode/qwen3.6-plus-free
permission:
  edit: deny
  bash:
    "*": ask
    "git status*": allow
---

You are the workflow review agent.

[Instructions...]
```

**Pi Prompt Format:**
```markdown
---
name: workflow-review
description: Reviews the current repository against workflow run goals
model: openai/gpt-4o
tools:
  bash:
    allow:
      - "git status*"
      - "git diff*"
  read: allow
  edit: deny
---

You are the workflow review agent.

[Instructions...]
```

### 7.2 Files to Convert

| OpenCode | Pi | Status |
|----------|-----|--------|
| `.opencode/agents/workflow-review.md` | `src/prompts/workflow-review.md` | Convert |
| `.opencode/agents/workflow-plan.md` | `src/prompts/workflow-plan.md` | Convert |
| `.opencode/agents/workflow-build.md` | `src/prompts/workflow-build.md` | Convert |
| `.opencode/agents/workflow-build-fast.md` | `src/prompts/workflow-build-fast.md` | Convert |
| `.opencode/agents/workflow-deep-thinker.md` | `src/prompts/workflow-deep-thinker.md` | Convert |
| `.opencode/agents/workflow-review-autonomous.md` | `src/prompts/workflow-review-autonomous.md` | Convert |
| `.opencode/agents/workflow-repair.md` | `src/prompts/workflow-repair.md` | Convert |
| `.opencode/skills/workflow-task-setup/SKILL.md` | `src/skills/workflow-task-setup/SKILL.md` | Adapt |

---

## Phase 8: Skill Conversion

### 8.1 Task Setup Skill

**Current:** OpenCode-specific skill for creating kanban tasks

**Pi Adaptation:**
- Keep the skill content largely the same
- Update API references from OpenCode SDK to pi ExtensionAPI
- Remove references to OpenCode-specific concepts
- Update example code to use pi patterns

---

## Phase 9: Key API Mappings

### 9.1 SDK Client Methods

| OpenCode | Pi | Notes |
|----------|-----|-------|
| `client.session.create()` | `pi.createSession()` | New session creation |
| `client.session.prompt()` | Use prompt injection | Sending prompts |
| `client.session.delete()` | `pi.deleteSession()` | Session deletion |
| `client.app.log()` | `pi.logger.info()` | Logging |
| `client.tui.showToast()` | `ctx.ui.notify()` | Notifications |
| `client.app.agents()` | `pi.listAgents()` | Available agents |
| `client.permission.reply()` | Handle via tool_call | Permission handling |

### 9.2 Event Mappings

| OpenCode Event | Pi Event | Notes |
|----------------|----------|-------|
| `chat.message` | `input` | User message hooks |
| `session.idle` | `before_agent_start` | Review orchestration |
| `permission.asked` | `tool_call` | Permission blocking |
| (new) | `session_start` | Session lifecycle |
| (new) | `session_shutdown` | Cleanup on exit |

---

## Phase 10: Testing & Verification

### 10.1 Conversion Checklist

- [ ] Entry point exports correct signature
- [ ] Config loader works with pi settings
- [ ] `#workflow` prefix detection works
- [ ] Tools register and execute properly
- [ ] Commands work in interactive, RPC, and print modes
- [ ] Review hook triggers on tool completion
- [ ] Kanban board displays correctly
- [ ] Task CRUD operations work
- [ ] Prompts render correctly
- [ ] Skill works in pi context

### 10.2 Required Testing

1. **Interactive Mode:** Full TUI with commands and tools
2. **RPC Mode:** JSON protocol with host application
3. **Print Mode:** No-UI operation for automation

---

## Implementation Order

1. **Phase 1-2:** Set up project structure, package.json, entry point
2. **Phase 3:** Adapt kanban system (minimal changes)
3. **Phase 4:** Implement hooks (`input`, `before_agent_start`, `tool_call`)
4. **Phase 5:** Register tools
5. **Phase 6:** Register commands
6. **Phase 7:** Convert prompts
7. **Phase 8:** Adapt skill
8. **Phase 9-10:** Test and verify

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Session management differs | Medium | Redesign review flow using `before_agent_start` |
| No built-in subagent concept | Medium | Use inline prompts or dedicated tools |
| Permission system different | Low | Adapt to tool_call blocking pattern |
| HTTP server conflicts | Low | Use configurable ports, graceful fallback |

---

## Appendix: Reference Files

### A.1 Key OpenCode Files (Source)

- `.opencode/plugins/easy-workflow.ts` - Main plugin
- `.opencode/easy-workflow/{db,server,orchestrator}.ts` - Kanban system
- `.opencode/agents/*.md` - Agent definitions
- `.opencode/skills/workflow-task-setup/SKILL.md` - Skill

### A.2 Key Pi Extension Files (Reference)

- `references/structure.md` - Project layout
- `references/tools.md` - Tool registration
- `references/commands.md` - Command registration
- `references/hooks.md` - Event hooks
- `references/modes.md` - Mode awareness
- `references/components.md` - TUI components
