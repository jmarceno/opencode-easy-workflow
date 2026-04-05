# Orchestrator Design: State Machine with Sub-Agent Sessions

**Date:** 2026-04-05
**Status:** Approved for Implementation

## Problem Statement

The pi extension needs an orchestrator that:
1. Creates sub-agent sessions for task execution (plan, build, review, repair)
2. Bypasses permission prompts so agents work autonomously
3. Manages task lifecycle through a predictable state machine
4. Runs in pi's extension environment (no direct `ExtensionAPI.createSession()`)

## Solution Architecture

### 1. Session Creation: `createAgentSession()`

Pi's `ExtensionAPI` does **not** expose session creation methods. However, the internal `@mariozechner/pi-coding-agent` package exports `createAgentSession()` which is used by the `pi-subagents` extension (122+ stars, production-proven).

```typescript
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
} from "@mariozechner/pi-coding-agent";

const sessionOpts = {
  cwd: ctx.cwd,
  sessionManager: SessionManager.inMemory(ctx.cwd),
  settingsManager: SettingsManager.create(),
  modelRegistry: ctx.modelRegistry,
  model: ctx.model,
  tools: [/* tool list */],
  resourceLoader: new DefaultResourceLoader({
    cwd: ctx.cwd,
    noExtensions: false,
    noSkills: false,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: () => customSystemPrompt,
  }),
};

const { session } = await createAgentSession(sessionOpts);
```

**Key properties:**
- `SessionManager.inMemory()` — session lives in memory, no file I/O
- `systemPromptOverride` — inject custom prompts for each task phase (plan, build, review)
- `tools` — full control over which tools the sub-agent gets
- After creation, call `session.bindExtensions()` to initialize extension-provided tools
- Run the agent with `await session.prompt(taskPrompt)`

### 2. Permission Bypass

Pi has **no built-in permission gate**. Permissions are a UI concept, not a framework feature. The `tool_call` hook is the only interception point.

**Strategy: Two-layer bypass**

**Layer 1 — `tool_call` hook auto-allow:**
```typescript
pi.on("tool_call", async (event, ctx) => {
  const sessionOwner = await getWorkflowSessionOwner(ctx);
  if (sessionOwner) {
    // Workflow-owned session — never block
    return undefined; // no block = auto-allow
  }
  // Non-workflow session — normal behavior
});
```

**Layer 2 — `skip_permission_asking` DB flag:**
The `workflow_sessions` table already has a `skip_permission_asking` column. When registering a workflow session, set this to `true`. The `getWorkflowSessionOwner()` function queries this table:

```typescript
async function getWorkflowSessionOwner(ctx: ExtensionContext): Promise<{
  taskId: string;
  kind: WorkflowSessionKind;
} | null> {
  const sessionId = ctx.sessionManager.getSessionId();
  const session = await db.getWorkflowSession(sessionId);
  if (!session || !session.skip_permission_asking) return null;
  return { taskId: session.task_id, kind: session.session_kind };
}
```

**Tool allowlists by session kind:**
```typescript
const allowedByKind: Record<WorkflowSessionKind, string[]> = {
  task: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  task_run_worker: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  review: ["read", "bash", "grep", "find", "ls"],
  plan: ["read", "bash", "grep", "find", "ls"],
  build: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  repair: ["read", "bash", "edit", "write", "grep", "find", "ls"],
};
```

### 3. State Machine Design

The orchestrator is a deterministic finite state machine (FSM) for each task.

#### Task State Transitions

```
                    ┌──────────────────────────────────────────┐
                    │                                          │
                    ▼                                          │
  template ──► backlog ──► executing ──► review ──► done      │
                    │            │         │                   │
                    │            │         ├──► stuck ─────┐   │
                    │            │         │               │   │
                    │            │         └──► failed ────┤   │
                    │            │                         │   │
                    │            └──► failed ──────────────┤   │
                    │                                      │   │
                    └──────────────────────────────────────┘   │
                                                               │
  stuck ──► backlog (requeue) ─────────────────────────────────┘
  failed ──► backlog (retry) ──────────────────────────────────┘
```

#### Execution Phase Sub-States

Within `executing` status, the `executionPhase` field tracks sub-progress:

```
not_started ──► plan_complete_waiting_approval ──► implementation_pending
              ──► implementation_done
              ──► plan_revision_pending
```

#### Best-of-N Sub-States

For `best_of_n` execution strategy:

```
idle ──► workers_running ──► reviewers_running ──► final_apply_running
       ──► blocked_for_manual_review ──► completed
```

### 4. Orchestrator Class Design

```typescript
// src/kanban/orchestrator.ts

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import { KanbanDB, type Task, type WorkflowSessionKind } from "./db";
import { loadPrompt } from "../prompts/loader";

export type OrchestratorEvent =
  | { type: "START_TASK"; taskId: string }
  | { type: "PLAN_COMPLETE"; taskId: string }
  | { type: "PLAN_APPROVED"; taskId: string }
  | { type: "PLAN_REJECTED"; taskId: string; feedback: string }
  | { type: "BUILD_COMPLETE"; taskId: string }
  | { type: "REVIEW_PASS"; taskId: string }
  | { type: "REVIEW_FAIL"; taskId: string; gaps: string[] }
  | { type: "TASK_FAILED"; taskId: string; error: string }
  | { type: "REPAIR_COMPLETE"; taskId: string }
  | { type: "REQUEUE"; taskId: string }
  | { type: "CANCEL"; taskId: string };

export type OrchestratorState =
  | { status: "idle" }
  | { status: "planning"; taskId: string; session: AgentSession }
  | { status: "waiting_approval"; taskId: string; plan: string }
  | { status: "building"; taskId: string; session: AgentSession }
  | { status: "reviewing"; taskId: string; session: AgentSession }
  | { status: "repairing"; taskId: string; session: AgentSession }
  | { status: "done"; taskId: string }
  | { status: "failed"; taskId: string; error: string }
  | { status: "stuck"; taskId: string; reason: string };

export class Orchestrator {
  private pi: ExtensionAPI;
  private db: KanbanDB;
  private state: Map<string, OrchestratorState> = new Map();
  private activeSessions: Map<string, AgentSession> = new Map();

  constructor(pi: ExtensionAPI, db: KanbanDB) {
    this.pi = pi;
    this.db = db;
  }

  async dispatch(event: OrchestratorEvent): Promise<void> {
    const task = await this.db.getTask(event.taskId);
    if (!task) throw new Error(`Task ${event.taskId} not found`);

    switch (event.type) {
      case "START_TASK":
        await this.handleStartTask(task);
        break;
      case "PLAN_COMPLETE":
        await this.handlePlanComplete(task);
        break;
      case "PLAN_APPROVED":
        await this.handlePlanApproved(task);
        break;
      case "PLAN_REJECTED":
        await this.handlePlanRejected(task, event.feedback);
        break;
      case "BUILD_COMPLETE":
        await this.handleBuildComplete(task);
        break;
      case "REVIEW_PASS":
        await this.handleReviewPass(task);
        break;
      case "REVIEW_FAIL":
        await this.handleReviewFail(task, event.gaps);
        break;
      case "TASK_FAILED":
        await this.handleTaskFailed(task, event.error);
        break;
      case "REPAIR_COMPLETE":
        await this.handleRepairComplete(task);
        break;
      case "REQUEUE":
        await this.handleRequeue(task);
        break;
      case "CANCEL":
        await this.handleCancel(task);
        break;
    }
  }

  // --- State handlers ---

  private async handleStartTask(task: Task): Promise<void> {
    await this.db.updateTask(task.id, { status: "executing", executionPhase: "not_started" });
    this.state.set(task.id, { status: "planning", taskId: task.id, session: null! });
    await this.runPlanningPhase(task);
  }

  private async runPlanningPhase(task: Task): Promise<void> {
    const systemPrompt = await loadPrompt("workflow-plan.md");
    const session = await this.createSubSession(task, "plan", systemPrompt);
    this.activeSessions.set(task.id, session);
    this.state.set(task.id, { status: "planning", taskId: task.id, session });

    const result = await session.prompt(task.prompt);
    await this.db.updateTask(task.id, {
      executionPhase: task.planmode ? "plan_complete_waiting_approval" : "implementation_pending",
      agentOutput: extractText(result),
    });

    if (task.planmode) {
      this.state.set(task.id, { status: "waiting_approval", taskId: task.id, plan: extractText(result) });
    } else {
      await this.dispatch({ type: "PLAN_APPROVED", taskId: task.id });
    }
  }

  private async handlePlanApproved(task: Task): Promise<void> {
    const systemPrompt = await loadPrompt("workflow-build.md");
    const session = await this.createSubSession(task, "build", systemPrompt);
    this.activeSessions.set(task.id, session);
    this.state.set(task.id, { status: "building", taskId: task.id, session });

    await this.db.updateTask(task.id, { executionPhase: "implementation_pending" });
    const result = await session.prompt(task.prompt);
    await this.db.updateTask(task.id, {
      executionPhase: "implementation_done",
      agentOutput: extractText(result),
    });

    await this.dispatch({ type: "BUILD_COMPLETE", taskId: task.id });
  }

  private async handleBuildComplete(task: Task): Promise<void> {
    if (!task.review) {
      await this.db.updateTask(task.id, { status: "done", completedAt: Date.now() });
      this.state.set(task.id, { status: "done", taskId: task.id });
      this.cleanupSession(task.id);
      return;
    }

    const session = await this.createSubSession(task, "review", await loadPrompt("workflow-review.md"));
    this.activeSessions.set(task.id, session);
    this.state.set(task.id, { status: "reviewing", taskId: task.id, session });

    const result = await session.prompt(buildReviewPrompt(task));
    const parsed = parseReviewResponse(extractText(result));

    if (parsed.status === "pass") {
      await this.dispatch({ type: "REVIEW_PASS", taskId: task.id });
    } else {
      await this.dispatch({ type: "REVIEW_FAIL", taskId: task.id, gaps: parsed.gaps });
    }
  }

  private async handleReviewPass(task: Task): Promise<void> {
    await this.db.updateTask(task.id, { status: "done", completedAt: Date.now() });
    this.state.set(task.id, { status: "done", taskId: task.id });
    this.cleanupSession(task.id);
  }

  private async handleReviewFail(task: Task, gaps: string[]): Promise<void> {
    const repairPrompt = await loadPrompt("workflow-repair.md");
    const session = await this.createSubSession(task, "repair", repairPrompt);
    this.activeSessions.set(task.id, session);
    this.state.set(task.id, { status: "repairing", taskId: task.id, session });

    await this.db.updateTask(task.id, {
      status: "executing",
      reviewCount: (task.reviewCount || 0) + 1,
    });

    const result = await session.prompt(buildRepairPrompt(task, gaps));
    await this.dispatch({ type: "REPAIR_COMPLETE", taskId: task.id });
  }

  private async handleRepairComplete(task: Task): Promise<void> {
    // Re-review after repair
    await this.handleBuildComplete(task);
  }

  private async handleTaskFailed(task: Task, error: string): Promise<void> {
    await this.db.updateTask(task.id, { status: "failed", errorMessage: error });
    this.state.set(task.id, { status: "failed", taskId: task.id, error });
    this.cleanupSession(task.id);
  }

  private async handleRequeue(task: Task): Promise<void> {
    await this.db.updateTask(task.id, { status: "backlog" });
    this.state.delete(task.id);
    this.cleanupSession(task.id);
  }

  private async handleCancel(task: Task): Promise<void> {
    await this.db.updateTask(task.id, { status: "failed", errorMessage: "Cancelled" });
    this.state.set(task.id, { status: "failed", taskId: task.id, error: "Cancelled" });
    this.cleanupSession(task.id);
  }

  // --- Session creation ---

  private async createSubSession(
    task: Task,
    kind: WorkflowSessionKind,
    systemPrompt: string,
  ): Promise<AgentSession> {
    const tools = this.getToolsForKind(kind);

    const loader = new DefaultResourceLoader({
      cwd: this.db.options.cwd ?? process.cwd(),
      noExtensions: false,
      noSkills: false,
      noPromptTemplates: true,
      noThemes: true,
      systemPromptOverride: () => systemPrompt,
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: this.db.options.cwd ?? process.cwd(),
      sessionManager: SessionManager.inMemory(this.db.options.cwd ?? process.cwd()),
      settingsManager: SettingsManager.create(),
      modelRegistry: this.pi.modelRegistry,
      model: this.pi.model,
      tools,
      resourceLoader: loader,
    });

    await session.bindExtensions({
      onError: (err) => this.pi.logger.error("Extension error:", err),
    });

    // Register as workflow session for permission bypass
    await this.db.registerWorkflowSession({
      session_id: session.id || crypto.randomUUID(),
      task_id: task.id,
      session_kind: kind,
      skip_permission_asking: true,
    });

    return session;
  }

  private getToolsForKind(kind: WorkflowSessionKind): any[] {
    // Return appropriate tool set based on session kind
    // This uses pi.getAllTools() and filters by kind
    const allTools = this.pi.getAllTools();
    const allowed = allowedByKind[kind] || [];
    return allTools.filter(t => allowed.includes(t.name));
  }

  private cleanupSession(taskId: string): void {
    const session = this.activeSessions.get(taskId);
    if (session) {
      // Session cleanup — in-memory sessions don't need file cleanup
      this.activeSessions.delete(taskId);
    }
  }

  getState(taskId: string): OrchestratorState | undefined {
    return this.state.get(taskId);
  }

  isRunning(taskId: string): boolean {
    const state = this.state.get(taskId);
    return state && !["done", "failed", "stuck", "idle"].includes(state.status);
  }
}
```

### 5. Integration with Hooks

The orchestrator integrates with existing hooks:

**`tool_call` hook** — permission bypass:
```typescript
pi.on("tool_call", async (event, ctx) => {
  const sessionOwner = await getWorkflowSessionOwner(db, ctx);
  if (sessionOwner) return undefined; // auto-allow
});
```

**`before_agent_start` hook** — review injection:
```typescript
pi.on("before_agent_start", async (event, ctx) => {
  const pendingReview = await findPendingReview(db, ctx);
  if (pendingReview) {
    const result = await runReview(pendingReview, ctx);
    event.systemPrompt += buildReviewContext(result);
  }
});
```

### 6. Concurrency Model

- One task at a time in foreground mode (sequential execution)
- Parallel execution possible with background mode using `pi-subagents` pattern
- Concurrency limit configurable (default: 1 for safety)
- Queue tasks in `backlog` status, dequeue when slot available

### 7. Error Handling

- Session errors → `TASK_FAILED` event → task status `failed`
- Review failures → `REVIEW_FAIL` event → repair phase → re-review
- Max review attempts → `stuck` status → manual intervention required
- Process crash → `cleanupStaleWorkflowSessions()` on next startup (24h TTL)

### 8. Dependencies

```
@/kanban/orchestrator.ts
├── @/kanban/db.ts (KanbanDB, workflow_sessions)
├── @/kanban/types.ts (Task, KanbanTask, WorkflowSessionKind)
├── @/hooks/tool-call.ts (permission bypass)
├── @/hooks/before-agent-start.ts (review injection)
├── @/utils/review.ts (review parsing)
├── @/prompts/*.md (workflow-plan, workflow-build, workflow-review, workflow-repair)
└── @mariozechner/pi-coding-agent (createAgentSession, SessionManager, etc.)
```

### 9. Type Fixes Required

Before implementing the orchestrator, fix these type mismatches in `db.ts`:

1. `Task` type — currently imported from `./types` but doesn't exist. Either:
   - Add `Task` to `types.ts` as alias: `export type Task = KanbanTask;`
   - Or rename `KanbanTask` to `Task` everywhere

2. Missing fields in `KanbanTask`:
   - `autoApprovePlan: boolean`
   - `planRevisionCount: number`
   - `skipPermissionAsking: boolean`

3. `ExecutionPhase` missing `"plan_revision_pending"` — add to union

4. Add `WorkflowSessionKind` to `types.ts` exports

### 10. Implementation Order

1. Fix type mismatches in `types.ts` and `db.ts`
2. Create `src/kanban/orchestrator.ts` with state machine
3. Wire orchestrator into `src/tools/workflow-tools.ts` (replace stubs)
4. Wire orchestrator into `src/commands/task.ts` (replace stubs)
5. Implement `getWorkflowSessionOwner()` in `tool-call.ts` (replace stub)
6. Implement `findPendingReview()` and `runReview()` in `review.ts` (replace stubs)
7. Integration testing
