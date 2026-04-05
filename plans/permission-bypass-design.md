# Permission Bypass Design for Workflow Sessions

**Date:** 2026-04-05
**Status:** Approved for Implementation

## Problem

Workflow agents (plan, build, review, repair) need to execute tools without user intervention. Pi has no built-in permission system — permissions are a UI concept, not a framework feature.

## Solution: Two-Layer Auto-Allow

### Layer 1: `tool_call` Hook Interception

The `tool_call` event is the only interception point before tool execution:

```typescript
pi.on("tool_call", async (event, ctx) => {
  // Check if this session belongs to a workflow task
  const sessionOwner = await getWorkflowSessionOwner(db, ctx);
  if (!sessionOwner) return; // Not a workflow session — normal behavior

  // Check if this tool is allowed for this session kind
  const allowed = getToolsForKind(sessionOwner.kind);
  if (!allowed.includes(event.toolName)) {
    return { block: true, reason: `Tool ${event.toolName} not allowed for ${sessionOwner.kind} sessions` };
  }

  // Return undefined = no block = auto-allow
});
```

**Return semantics:**
- `undefined` — tool execution proceeds (auto-allow)
- `{ block: true, reason: "..." }` — tool execution blocked
- Mutating `event.input` — modify tool arguments before execution

### Layer 2: Database Flag

The `workflow_sessions` table tracks which sessions are workflow-owned:

```sql
CREATE TABLE IF NOT EXISTS workflow_sessions (
  session_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  session_kind TEXT NOT NULL,  -- 'task', 'task_run_worker', 'review', 'plan', 'build', 'repair'
  skip_permission_asking BOOLEAN NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

When a sub-session is created by the orchestrator, it is registered:

```typescript
await db.registerWorkflowSession({
  session_id: session.id || crypto.randomUUID(),
  task_id: task.id,
  session_kind: kind,  // 'plan', 'build', 'review', 'repair'
  skip_permission_asking: true,
});
```

### Session Kind Tool Allowlists

```typescript
const TOOL_ALLOWLIST: Record<WorkflowSessionKind, string[]> = {
  task: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  task_run_worker: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  review: ["read", "bash", "grep", "find", "ls"],
  plan: ["read", "bash", "grep", "find", "ls"],
  build: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  repair: ["read", "bash", "edit", "write", "grep", "find", "ls"],
};
```

### Implementation in `tool-call.ts`

Replace the current stub:

```typescript
// BEFORE (stub):
async function getWorkflowSessionOwner(ctx: ExtensionContext): Promise<...> {
  return null; // TODO: query kanban DB
}

// AFTER (implementation):
async function getWorkflowSessionOwner(
  db: KanbanDB,
  ctx: ExtensionContext,
): Promise<{ taskId: string; kind: WorkflowSessionKind } | null> {
  const sessionId = ctx.sessionManager.getSessionId();
  const session = await db.getWorkflowSession(sessionId);
  if (!session || !session.skip_permission_asking) return null;
  return {
    taskId: session.task_id,
    kind: session.session_kind as WorkflowSessionKind,
  };
}
```

### Why This Works

1. **Pi has no permission gate** — there is no `permission.asked` event or auto-confirm setting
2. **`tool_call` hook is the only gate** — returning `{ block: true }` stops execution; returning `undefined` allows it
3. **Workflow sessions are pre-registered** — the orchestrator registers each sub-session before it runs
4. **Tool filtering at session creation** — sub-sessions only get the tools they need (defense in depth)

### Security Considerations

- Only sessions registered in `workflow_sessions` table get auto-allow
- Tool allowlists restrict what each session kind can do
- `skip_permission_asking` flag provides an additional DB-level check
- Review/plan sessions are read-only (no edit/write tools)
- Build/repair sessions get write tools but are still tracked

### Cleanup

Stale workflow sessions are cleaned up on startup:

```typescript
// Remove sessions older than 24 hours
await db.cleanupStaleWorkflowSessions();
```

This prevents orphaned sessions from getting auto-allow after their task is complete.
