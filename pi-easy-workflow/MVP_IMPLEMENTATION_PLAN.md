# Pi MVP Implementation Plan: Gaps 1-3

## Executive Summary

This plan addresses the three critical gaps identified in the Pi MVP migration:

1. **Gap 1 (Blocker)**: `startAll` does not dynamically pull newly-unblocked dependency tasks
2. **Gap 2 (Blocker)**: Session viewer live updates are not fully websocket-driven  
3. **Gap 3 (High Priority)**: Telegram notification parity is incomplete

## Gap 1: Dynamic Dependency Scheduling in startAll

### Current Behavior
The `startAll()` method in `pi-easy-workflow/src/orchestrator.ts` calls `resolveExecutionTasks()` which only returns tasks whose dependencies are **already** `done`. It doesn't include tasks whose dependencies will be satisfied by other tasks in the same run.

### Root Cause
In `orchestrator.ts` lines 60-82, `startAll()` uses `resolveExecutionTasks(this.db.getTasks())` which internally uses `getExecutableTasks()`. This only returns tasks where `areTaskRequirementsDone()` returns true - meaning dependencies must already be `done`. The legacy version uses `getExecutionGraphTasks()` which considers both `done` tasks AND tasks that will be scheduled in the same run.

### Solution
Replace `resolveExecutionTasks()` with a call to `buildExecutionGraph()` (or a similar function) that computes the full set of tasks that will be executable during this run, considering that dependencies will be satisfied by other tasks in the execution set.

### Files to Modify

#### 1. `pi-easy-workflow/src/execution-plan.ts`

**Changes needed:**

1. **Export `getExecutionGraphTasks`** (add export keyword at line 223):
   ```typescript
   export function getExecutionGraphTasks(tasks: Task[]): Task[] {
   ```

2. **Add new function `resolveAllExecutionTasks`** (after line 221):
   ```typescript
   /**
    * Resolves all tasks that should be executed in a single run, including tasks
    * whose dependencies will be satisfied by other tasks in the same run.
    * This matches the legacy `getExecutionGraphTasks` behavior.
    */
   export function resolveAllExecutionTasks(tasks: Task[]): Task[] {
     return getExecutionGraphTasks(tasks)
   }
   ```

#### 2. `pi-easy-workflow/src/server/server.ts`

**Changes needed:**

The `/api/execution-graph` endpoint currently uses `getExecutableTasks()` which only returns tasks whose dependencies are already done. It should use `getExecutionGraphTasks()` to show the full execution plan.

1. **Update import** (line 6):
   ```typescript
   import { buildExecutionGraph, getExecutableTasks, getExecutionGraphTasks } from "../execution-plan.ts"
   ```

2. **Modify `/api/execution-graph` endpoint** (lines 476-510):
   ```typescript
   this.router.get("/api/execution-graph", ({ json }) => {
     // Use getExecutionGraphTasks to get ALL tasks that will run,
     // including those whose dependencies will be satisfied during this run
     const allExecutable = getExecutionGraphTasks(this.db.getTasks())
     if (allExecutable.length === 0) return json({ error: "No tasks in backlog" }, 400)

     const options = this.db.getOptions()
     // Pass the full task set to buildExecutionGraph
     const graph = buildExecutionGraph(this.db.getTasks(), options.parallelTasks)

     for (const node of graph.nodes) {
       const task = this.db.getTask(node.id)
       if (task?.executionStrategy === "best_of_n" && task.bestOfNConfig) {
         const cfg = task.bestOfNConfig as BestOfNConfig
         const workers = cfg.workers.reduce((sum, slot) => sum + slot.count, 0)
         const reviewers = cfg.reviewers.reduce((sum, slot) => sum + slot.count, 0)
         node.expandedWorkerRuns = workers
         node.expandedReviewerRuns = reviewers
         node.hasFinalApplier = true
         node.estimatedRunCount = workers + reviewers + 1
       } else {
         node.expandedWorkerRuns = 1
         node.expandedReviewerRuns = task?.review ? 1 : 0
         node.hasFinalApplier = false
         node.estimatedRunCount = 1 + (task?.review ? 1 : 0)
       }
     }

     graph.pendingApprovals = this.db.getTasks().filter((task) => isTaskAwaitingPlanApproval(task)).map((task) => ({
       id: task.id,
       name: task.name,
       status: task.status,
       awaitingPlanApproval: task.awaitingPlanApproval,
       planRevisionCount: task.planRevisionCount,
     }))

     return json(graph)
   })
   ```

#### 3. `pi-easy-workflow/src/execution-plan.ts`

**Additional change needed:**

The `buildExecutionGraph` function currently calls `getExecutionGraphTasks` internally, but we need to ensure it properly filters the passed tasks. Update the function signature to optionally accept pre-filtered tasks:

1. **Modify `buildExecutionGraph`** (lines 253-284):
   ```typescript
   export function buildExecutionGraph(tasks: Task[], parallelLimit: number): ExecutionGraph {
     // Use getExecutionGraphTasks to compute the full execution set
     const executableTasks = getExecutionGraphTasks(tasks)
     const batches = resolveBatches(executableTasks, parallelLimit)

     const nodes = executableTasks.map(t => ({
       id: t.id,
       name: t.name,
       status: t.status,
       requirements: t.requirements,
     }))

     const edges: { from: string; to: string }[] = []
     for (const t of executableTasks) {
       for (const dep of t.requirements) {
         if (executableTasks.some(et => et.id === dep)) {
           edges.push({ from: dep, to: t.id })
         }
       }
     }

     return {
       batches: batches.map((batch, idx) => ({
         idx,
         taskIds: batch.map(t => t.id),
         taskNames: batch.map(t => t.name),
       })),
       nodes,
       edges,
       totalTasks: executableTasks.length,
       parallelLimit,
     }
   }
   ```

#### 4. `pi-easy-workflow/src/orchestrator.ts`

**Changes needed:**

1. **Update import** (line 9):
   ```typescript
   import { resolveExecutionTasks, getExecutionGraphTasks } from "./execution-plan.ts"
   ```

2. **Modify `startAll` method** (lines 60-82):
   - Use `getExecutionGraphTasks` instead of `resolveExecutionTasks`
   - This will include tasks whose dependencies are not yet done but will be executed in the same run

   ```typescript
   async startAll(): Promise<WorkflowRun> {
     if (this.running) throw new Error("Already executing")
     
     // Use getExecutionGraphTasks to get ALL tasks that will run,
     // including those whose dependencies will be satisfied during this run
     const tasks = getExecutionGraphTasks(this.db.getTasks())
     
     if (tasks.length === 0) throw new Error("No tasks in backlog")

     const run = this.db.createWorkflowRun({
       id: randomUUID().slice(0, 8),
       kind: "all_tasks",
       status: "running",
       displayName: "Workflow run",
       taskOrder: tasks.map((task) => task.id),
       currentTaskId: tasks[0]?.id ?? null,
       currentTaskIndex: 0,
     })

     this.currentRunId = run.id
     this.running = true
     this.shouldStop = false
     this.broadcast({ type: "run_created", payload: run })
     this.broadcast({ type: "execution_started", payload: {} })

     void this.runInBackground(run.id, tasks.map((task) => task.id))
     return run
   }
   ```

3. **Modify `runInBackground` to validate dependencies before execution** (lines 122-159):
   - The task order is already computed upfront
   - Before executing each task, validate that its dependencies are satisfied
   - Dependencies should be satisfied either by being already `done` OR by having been executed earlier in this run

   ```typescript
   private async runInBackground(runId: string, taskIds: string[]): Promise<void> {
     const executedTaskIds = new Set<string>()
     
     try {
       for (let index = 0; index < taskIds.length; index++) {
         if (this.shouldStop) break
         
         const taskId = taskIds[index]
         const task = this.db.getTask(taskId)
         if (!task) continue

         // Validate dependencies are satisfied (either already done or executed in this run)
         for (const depId of task.requirements) {
           const dep = this.db.getTask(depId)
           if (dep && dep.status !== "done" && !executedTaskIds.has(depId)) {
             const msg = `Dependency "${dep.name}" is not done (status: ${dep.status})`
             this.db.updateTask(task.id, { status: "failed", errorMessage: msg })
             this.broadcastTask(task.id)
             throw new Error(msg)
           }
         }

         const updatedRun = this.db.updateWorkflowRun(runId, {
           currentTaskId: task.id,
           currentTaskIndex: index,
         })
         if (updatedRun) this.broadcast({ type: "run_updated", payload: updatedRun })

         await this.executeTask(task, this.db.getOptions())
         executedTaskIds.add(taskId)
       }

       const finalRun = this.db.updateWorkflowRun(runId, {
         status: this.shouldStop ? "completed" : "completed",
         stopRequested: this.shouldStop,
         finishedAt: nowUnix(),
       })
       if (finalRun) this.broadcast({ type: "run_updated", payload: finalRun })
       this.broadcast({ type: "execution_complete", payload: {} })
     } catch (error) {
       const message = error instanceof Error ? error.message : String(error)
       const failed = this.db.updateWorkflowRun(runId, {
         status: "failed",
         errorMessage: message,
         finishedAt: nowUnix(),
       })
       if (failed) this.broadcast({ type: "run_updated", payload: failed })
       this.broadcast({ type: "error", payload: { message } })
     } finally {
       this.running = false
       this.currentRunId = null
       this.broadcast({ type: "execution_stopped", payload: {} })
     }
   }
   ```

### Acceptance Criteria
- [ ] When Task A depends on Task B, and both are in backlog, `startAll` includes both in the run's `taskOrder`
- [ ] Tasks execute in the correct dependency order (Task B before Task A)
- [ ] The execution set is computed once at the start and doesn't change during the run
- [ ] Tasks added to the board after the run starts are NOT included in the current run
- [ ] The algorithm matches the legacy `getExecutionGraphTasks` behavior

---

## Gap 2: WebSocket Session Message Broadcasting

### Current Behavior
Session messages are persisted to the database via `createSessionMessage()` in `pi-process.ts`, but WebSocket broadcasts for `session_message_created` events are not sent. The session viewer modal can load historical data but doesn't receive real-time updates.

### Root Cause
In `pi-easy-workflow/src/runtime/pi-process.ts` lines 207-219, session messages are created via `this.db.createSessionMessage(message)` but no WebSocket broadcast is emitted. The legacy version broadcasts `session_message_created` events that the UI listens for.

### Solution
Add WebSocket broadcasts in the Pi runtime when session messages are created and when session status changes occur.

### Files to Modify

#### 1. `pi-easy-workflow/src/runtime/pi-process.ts`

**Changes needed:**

1. **Add broadcast callback to constructor** (line 46-54):
   ```typescript
   export class PiRpcProcess {
     private readonly db: PiKanbanDB
     private readonly session: PiWorkflowSession
     private readonly onOutput?: (chunk: string) => void
     private readonly onSessionMessage?: (message: SessionMessage) => void  // NEW
     // ...
   }
   ```

2. **Update constructor to accept callback** (line 56-54):
   ```typescript
   constructor(args: {
     db: PiKanbanDB
     session: PiWorkflowSession
     onOutput?: (chunk: string) => void
     onSessionMessage?: (message: SessionMessage) => void  // NEW
   }) {
     this.db = args.db
     this.session = args.session
     this.onOutput = args.onOutput
     this.onSessionMessage = args.onSessionMessage  // NEW
   }
   ```

3. **Broadcast session message after creation** (around line 214, after `createSessionMessage`):
   ```typescript
   // In handleStdoutLine method, after creating session message:
   if (message.contentJson && Object.keys(message.contentJson).length > 0) {
     const createdMessage = this.db.createSessionMessage(message)
     if (createdMessage && this.onSessionMessage) {
       this.onSessionMessage(createdMessage)
     }
     // ... existing output handling
   }
   ```

#### 2. `pi-easy-workflow/src/runtime/session-manager.ts`

**Changes needed:**

1. **Add broadcast parameter to executePrompt** (lines 38-49):
   ```typescript
   export interface ExecuteSessionPromptInput {
     taskId: string
     taskRunId?: string | null
     sessionKind: PiSessionKind
     cwd: string
     worktreeDir?: string | null
     branch?: string | null
     model?: string
     thinkingLevel?: ThinkingLevel
     promptText: string
     onOutput?: (chunk: string) => void
     onSessionMessage?: (message: SessionMessage) => void  // NEW
   }
   ```

2. **Pass broadcast callback to PiRpcProcess** (lines 75-79):
   ```typescript
   const process = new PiRpcProcess({
     db: this.db,
     session,
     onOutput: input.onOutput,
     onSessionMessage: input.onSessionMessage,  // NEW
   })
   ```

#### 3. `pi-easy-workflow/src/orchestrator.ts`

**Changes needed:**

1. **Update `runSessionPrompt` to broadcast session messages** (lines 593-631):
   ```typescript
   private async runSessionPrompt(input: { ... }): Promise<...> {
     const session = await this.sessionManager.executePrompt({
       taskId: input.task.id,
       sessionKind: input.sessionKind,
       cwd: input.cwd,
       worktreeDir: input.worktreeDir,
       branch: input.branch,
       model: input.model,
       thinkingLevel: input.task.thinkingLevel,
       promptText: input.promptText,
       onOutput: (chunk) => { ... },
       onSessionMessage: (message) => {  // NEW
         this.broadcast({
           type: "session_message_created",
           payload: message,
         })
       },
     })
     // ... rest of method
   }
   ```

#### 4. `pi-easy-workflow/src/types.ts`

**Changes needed:**

1. **Add new WSMessage type variant** (check existing WSMessage definition):
   ```typescript
   export type WSMessage =
     | { type: "task_created"; payload: Task }
     | { type: "task_updated"; payload: Task }
     // ... existing types
     | { type: "session_message_created"; payload: SessionMessage }  // NEW
   ```

### Acceptance Criteria
- [ ] When a Pi session generates a message, a `session_message_created` WebSocket event is broadcast
- [ ] The session viewer modal receives real-time updates without requiring a refresh
- [ ] Session status changes (active → completed/failed) are also broadcast via WebSocket
- [ ] The broadcast payload matches the SessionMessage type from the database

---

## Gap 3: Telegram Notification Parity

### Current Behavior
The Pi version has database fields and UI options for Telegram notifications (`telegramBotToken`, `telegramChatId`, `telegramNotificationsEnabled`), but the actual notification sending logic is not implemented. The legacy version sends notifications on task status changes and workflow completion.

### Root Cause
In `pi-easy-workflow/src/server/server.ts`, there's no `setTaskStatusChangeListener` equivalent to the legacy implementation. The legacy uses this listener to trigger Telegram notifications whenever a task's status changes.

### Solution
Implement a status change listener mechanism in the database layer and wire it up to send Telegram notifications, matching the legacy behavior.

### Files to Create/Modify

#### 1. `pi-easy-workflow/src/telegram.ts` (NEW FILE)

**Purpose:** Port the Telegram notification service from legacy

**Content (based on legacy `src/telegram.ts`):**
```typescript
export interface TelegramConfig {
  botToken: string
  chatId: string
}

export interface TelegramSendResult {
  success: boolean
  messageId?: number
  error?: string
}

const STATUS_EMOJI: Record<string, string> = {
  template: "\u{1F4C4}",
  backlog: "\u{1F4CC}",
  executing: "\u{25B6}",
  review: "\u{1F9E9}",
  done: "\u{2705}",
  failed: "\u274C",
  stuck: "\u{1F6AB}",
}

function buildMessage(taskName: string, oldStatus: string, newStatus: string): string {
  const emoji = STATUS_EMOJI[newStatus] ?? "\u{1F4AC}"
  const time = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC"
  return [
    `${emoji} *Task State Update*`,
    ``,
    `*Task:* ${taskName}`,
    `*From:* \`${oldStatus}\` \u2192 *To:* \`${newStatus}\``,
    ``,
    `_${time}_`,
  ].join("\n")
}

export async function sendTelegramNotification(
  config: TelegramConfig,
  taskName: string,
  oldStatus: string,
  newStatus: string,
  logger: (msg: string) => void = console.log
): Promise<TelegramSendResult> {
  if (!config.botToken || !config.chatId) {
    return { success: false, error: "not configured" }
  }

  const message = buildMessage(taskName, oldStatus, newStatus)
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: message,
        parse_mode: "Markdown",
      }),
    })

    if (!response.ok) {
      const body = await response.text()
      logger(`[telegram] send failed: ${response.status} ${body}`)
      return { success: false, error: `HTTP ${response.status}: ${body}` }
    }

    let messageId: number | undefined
    try {
      const data = await response.json() as any
      messageId = data?.result?.message_id
    } catch {
      // Ignore JSON parse errors
    }

    logger(`[telegram] notification sent for "${taskName}" (${oldStatus} → ${newStatus})`)
    return { success: true, messageId }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger(`[telegram] send error: ${msg}`)
    return { success: false, error: msg }
  }
}
```

#### 2. `pi-easy-workflow/src/db.ts`

**Changes needed:**

1. **Add listener type and field** (after line 70):
   ```typescript
   export type TaskStatusChangeListener = (taskId: string, oldStatus: TaskStatus, newStatus: TaskStatus) => void
   ```

2. **Add listener storage to PiKanbanDB class** (after constructor):
   ```typescript
   export class PiKanbanDB {
     private db: Database
     private readonly dbPath: string
     private _taskStatusChangeListener: TaskStatusChangeListener | null = null  // NEW
     // ...
   }
   ```

3. **Add setter method** (after constructor, around line 920):
   ```typescript
   setTaskStatusChangeListener(listener: TaskStatusChangeListener | null): void {
     this._taskStatusChangeListener = listener
   }
   ```

4. **Modify updateTask to detect status changes and notify** (in updateTask method, around line 974):
   ```typescript
   updateTask(id: string, input: UpdateTaskInput): Task | null {
     // Get current task before update to check for status change
     const currentTask = this.getTask(id)
     const oldStatus = currentTask?.status
     
     // ... existing update logic ...
     
     const updatedTask = this.getTask(id)
     
     // Notify listener if status changed
     if (updatedTask && oldStatus && input.status !== undefined && input.status !== oldStatus) {
       this._taskStatusChangeListener?.(id, oldStatus, input.status)
     }
     
     return updatedTask
   }
   ```

#### 3. `pi-easy-workflow/src/server/server.ts`

**Changes needed:**

1. **Import Telegram functions** (line 1-15):
   ```typescript
   import { sendTelegramNotification, type TelegramConfig } from "../telegram.ts"
   ```

2. **Register status change listener in constructor** (after line 141):
   ```typescript
   constructor(...) {
     // ... existing constructor logic ...
     
     // Register Telegram notification listener for task status changes
     this.db.setTaskStatusChangeListener((taskId: string, oldStatus: string, newStatus: string) => {
       const task = this.db.getTask(taskId)
       if (!task) return
       const opts = this.db.getOptions()
       if (!opts.telegramNotificationsEnabled || !opts.telegramBotToken || !opts.telegramChatId) return
       
       sendTelegramNotification(
         { botToken: opts.telegramBotToken, chatId: opts.telegramChatId },
         task.name,
         oldStatus,
         newStatus,
         (msg: string) => console.debug(msg)
       ).catch((err: unknown) => {
         console.error("[telegram] notification failed:", err)
       })
     })
   }
   ```

### Acceptance Criteria
- [ ] When a task's status changes (e.g., executing → done), a Telegram notification is sent
- [ ] Notifications are only sent when `telegramNotificationsEnabled` is true and credentials are configured
- [ ] Notifications include task name, old status, new status, and timestamp
- [ ] Errors in sending notifications are logged but don't fail the workflow
- [ ] The implementation matches the legacy behavior for notification triggers

---

## Implementation Order

1. **Gap 1** (Dynamic Dependency Scheduling) - Highest priority as it's a core workflow feature
2. **Gap 2** (WebSocket Broadcasting) - Enables real-time session viewer functionality
3. **Gap 3** (Telegram Notifications) - User experience improvement for monitoring

## Testing Strategy

### Gap 1 Tests
1. Create Task A with no dependencies
2. Create Task B that depends on Task A
3. Run `startAll` - Task A should execute first
4. After Task A completes, Task B should automatically execute in the same run

### Gap 2 Tests
1. Start a task that creates a Pi session
2. Open the session viewer modal
3. Verify that session messages appear in real-time as the session progresses

### Gap 3 Tests
1. Configure Telegram bot token and chat ID in options
2. Enable Telegram notifications
3. Run a task through completion
4. Verify that status change notifications are received in Telegram

## Files Summary

### Modified Files:
1. `pi-easy-workflow/src/execution-plan.ts` - Gap 1 (export getExecutionGraphTasks, ensure buildExecutionGraph uses it)
2. `pi-easy-workflow/src/server/server.ts` - Gap 1 (fix /api/execution-graph to show full task set)
3. `pi-easy-workflow/src/orchestrator.ts` - Gap 1 & 2
4. `pi-easy-workflow/src/runtime/pi-process.ts` - Gap 2
5. `pi-easy-workflow/src/runtime/session-manager.ts` - Gap 2
6. `pi-easy-workflow/src/types.ts` - Gap 2 (add WSMessage type)
7. `pi-easy-workflow/src/db.ts` - Gap 3

### New Files:
1. `pi-easy-workflow/src/telegram.ts` - Gap 3
