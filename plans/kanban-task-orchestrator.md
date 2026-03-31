# Kanban Task Orchestrator - Implementation Plan

## Overview

Expand the Easy Workflow plugin into a full kanban-board task management system with dependency-aware execution. The plugin spawns an embedded HTTP/WebSocket server serving a kanban UI, stores tasks in SQLite, and orchestrates execution through OpenCode sessions in isolated git worktrees.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    OpenCode Process                          │
│  ┌──────────────────┐    ┌───────────────────────────────┐  │
│  │ Existing Plugin  │    │  Embedded HTTP + WS Server    │  │
│  │ (chat.message,   │    │  (Bun.serve on :PORT)         │  │
│  │  event hooks)    │    │                               │  │
│  │                  │    │  ┌─────────┐  ┌────────────┐  │  │
│  │  Still handles   │    │  │Static UI│  │WebSocket   │  │  │
│  │  #workflow msgs  │    │  │HTML/CSS │  │/ws channel │  │  │
│  └────────┬─────────┘    │  └─────────┘  └─────┬──────┘  │  │
│           │              └─────────────────────┼─────────┘  │
│           │                                    │            │
│  ┌────────▼────────────────────────────────────▼─────────┐  │
│  │              Task Orchestrator                         │  │
│  │  - Dependency graph resolution (topological sort)     │  │
│  │  - Sequential / parallel batch execution              │  │
│  │  - Worktree lifecycle management                      │  │
│  │  - Session creation, prompt, monitoring               │  │
│  │  - Review integration (reuses workflow.md review)     │  │
│  └────────┬────────────────────────────────────┬─────────┘  │
│           │                                    │            │
│  ┌────────▼─────────┐              ┌───────────▼──────────┐  │
│  │  bun:sqlite DB   │              │  OpenCode SDK Client │  │
│  │  tasks.db        │              │  (session, worktree, │  │
│  │                  │              │   prompt APIs)       │  │
│  └──────────────────┘              └──────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Constraints & Decisions

| Decision | Choice |
|----------|--------|
| UI Hosting | Embedded Bun HTTP server on dedicated port |
| Plan Mode | Uses OpenCode's built-in `plan` agent |
| Command Field | Pre-execution shell command |
| Parallel Tasks | One worktree per task (full isolation) |
| Stuck in Review | Full halt of entire pipeline |
| Error on Execution | Full halt (fail-fast) |
| SQLite | `bun:sqlite` directly (available in plugin's Bun process) |
| WebSocket | Native `Bun.serve()` WebSocket upgrade |

## Database Schema

**File:** `.opencode/easy-workflow/tasks.db`

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,              -- nanoid (8 chars)
  name TEXT NOT NULL,
  idx INTEGER NOT NULL DEFAULT 0,   -- user-editable ordering
  prompt TEXT NOT NULL,
  plan_model TEXT NOT NULL DEFAULT 'default',
  execution_model TEXT NOT NULL DEFAULT 'default',
  planmode INTEGER NOT NULL DEFAULT 0,
  review INTEGER NOT NULL DEFAULT 1,
  auto_commit INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'backlog',  -- backlog|executing|review|done|failed|stuck
  requirements TEXT NOT NULL DEFAULT '[]', -- JSON array of task IDs
  agent_output TEXT DEFAULT '',             -- captured agent output
  review_count INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,                          -- OpenCode session ID (if active)
  worktree_dir TEXT,                        -- worktree directory (if active)
  error_message TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER
);

CREATE TABLE options (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Default options
INSERT INTO options VALUES
  ('commit_prompt', 'feat: {{task_name}}'),
  ('plan_model', 'default'),
  ('execution_model', 'default'),
  ('command', ''),
  ('parallel_tasks', '1'),
  ('port', '3789');

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_idx ON tasks(idx);
```

## File Structure

```
.opencode/
├── plugins/
│   └── easy-workflow.ts          # REFACTORED: thin wrapper, imports kanban modules
├── agents/
│   └── workflow-review.md        # UNCHANGED
├── easy-workflow/
│   ├── workflow.md               # UNCHANGED (review config)
│   ├── tasks.db                  # NEW: SQLite database
│   ├── debug.log                 # UNCHANGED
│   ├── runs/                     # UNCHANGED (legacy workflow runs)
│   ├── server.ts                 # NEW: HTTP + WebSocket server
│   ├── db.ts                     # NEW: SQLite database layer
│   ├── orchestrator.ts           # NEW: Task execution engine
│   ├── types.ts                  # NEW: Shared TypeScript types
│   └── kanban/
│       └── index.html            # NEW: Embedded kanban UI (single file)
└── package.json                  # UNCHANGED (bun:sqlite needs no dep)
```

## Module Details

### 1. `types.ts` — Shared Types

```typescript
export type TaskStatus = "backlog" | "executing" | "review" | "done" | "failed" | "stuck"

export interface Task {
  id: string
  name: string
  idx: number
  prompt: string
  planModel: string        // "default" means use global
  executionModel: string   // "default" means use global
  planmode: boolean
  review: boolean
  autoCommit: boolean
  status: TaskStatus
  requirements: string[]   // array of task IDs
  agentOutput: string
  reviewCount: number
  sessionId: string | null
  worktreeDir: string | null
  errorMessage: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export interface Options {
  commitPrompt: string
  planModel: string        // global default
  executionModel: string   // global default
  command: string          // pre-execution shell command
  parallelTasks: number
  port: number
}

export type WSMessageType =
  | "task_created"
  | "task_updated"
  | "task_deleted"
  | "task_reordered"
  | "options_updated"
  | "execution_started"
  | "execution_stopped"
  | "execution_complete"
  | "agent_output"
  | "error"

export interface WSMessage {
  type: WSMessageType
  payload: any
}
```

### 2. `db.ts` — Database Layer

Thin wrapper around `bun:sqlite` with helper functions:

- `initDb(dbPath)` — Open/create database, run migrations
- `getTasks()` — All tasks ordered by idx
- `getTask(id)` — Single task by ID
- `createTask(task)` — Insert new task
- `updateTask(id, updates)` — Partial update
- `deleteTask(id)` — Delete task + remove from requirements of others
- `reorderTask(id, newIdx)` — Update idx and shift others
- `getTasksByStatus(status)` — Filter by status
- `getOptions()` / `updateOptions(partial)` — Options CRUD
- `recordAgentOutput(taskId, output)` — Append to agent_output
- `moveTask(taskId, fromStatus, toStatus)` — Atomic status transition

All methods return plain `Task` / `Options` objects. Uses `bun:sqlite` directly (Database from "bun:sqlite").

### 3. `server.ts` — HTTP + WebSocket Server

**HTTP Routes:**
- `GET /` — Serve kanban HTML
- `GET /api/tasks` — List all tasks
- `POST /api/tasks` — Create task
- `PATCH /api/tasks/:id` — Update task
- `DELETE /api/tasks/:id` — Delete task
- `PUT /api/tasks/reorder` — Reorder tasks
- `GET /api/options` — Get options
- `PUT /api/options` — Update options
- `POST /api/start` — Start execution
- `POST /api/stop` — Stop execution

**WebSocket:**
- `GET /ws` — WebSocket upgrade
- Broadcasts `WSMessage` to all connected clients
- Server pushes real-time task state changes

**Implementation:**
```typescript
import { Database } from "bun:sqlite"

const server = Bun.serve({
  port: options.port,
  async fetch(req, server) {
    const url = new URL(req.url)
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return
      return new Response("Upgrade failed", { status: 500 })
    }
    return handleHTTP(req)
  },
  websocket: {
    open(ws) { clients.add(ws) },
    close(ws) { clients.delete(ws) },
    message(ws, msg) { /* handle client messages */ },
  }
})
```

**Broadcasting:**
```typescript
function broadcast(msg: WSMessage) {
  const data = JSON.stringify(msg)
  for (const ws of clients) ws.send(data)
}
```

### 4. `orchestrator.ts` — Task Execution Engine

The orchestrator manages the full task lifecycle.

#### Startup Sequence (`start()`)

```
1. Validate: at least 1 task in backlog
2. Build dependency graph from all tasks
3. Topological sort → execution order
4. Detect cycles → error if found
5. Enter execution loop
```

#### Dependency Resolution

```
Input: all tasks with requirements[]
Output: ordered batches[][] (each batch can run in parallel)

Algorithm:
1. Build adjacency list: task → dependencies
2. Kahn's algorithm for topological sort
3. Group into levels: tasks with no remaining deps at each level
4. Within each level, sort by task.idx (ascending)
5. Respect parallelTasks limit per batch
```

Example:
```
Task A (idx:1, deps: [])
Task B (idx:2, deps: [A])
Task C (idx:3, deps: [A])
Task D (idx:4, deps: [B, C])

Batches (parallel=2):
  Batch 1: [A]
  Batch 2: [B, C]  (both depend only on A, same level)
  Batch 3: [D]     (depends on B and C)
```

#### Single Task Execution (`executeTask(task)`)

```
1. Update task status → "executing"
2. Broadcast: task_updated
3. Create worktree:
   const worktree = await client.experimental.worktree.create({
     body: { name: `task-${task.id}` }
   })
4. Store worktreeDir on task
5. Run pre-execution command (if task.command or global command):
   Bun.$`cd ${worktreeDir} && ${command}`
6. Create session (in worktree context):
   const session = await client.session.create({
     body: { title: `Task: ${task.name}` }
   })
7. Store sessionId on task
8. Determine agent: task.planmode ? "plan" : undefined (default agent)
9. Determine model:
   - For planning: task.planModel !== "default" ? task.planModel : global planModel
   - For execution: task.executionModel !== "default" ? task.executionModel : global executionModel
10. Send prompt (sync):
    const response = await client.session.prompt({
      path: { sessionID: session.id },
      body: {
        agent: agent,
        model: parseModel(model),
        parts: [{ type: "text", text: task.prompt }]
      }
    })
11. Capture output:
    const textParts = response.parts.filter(p => p.type === "text")
    const output = textParts.map(p => p.text).join("\n")
    recordAgentOutput(task.id, output)
    broadcast: { type: "agent_output", payload: { taskId: task.id, output } }
12. If task.review:
    a. Update status → "review", broadcast
    b. Run review loop (max from workflow.md template):
       - Read template, get maxReviewRuns
       - For each review iteration:
         i. Run review via scratch session (same pattern as current extractGoals)
         ii. If STATUS: pass → break
         iii. If STATUS: gaps_found → send follow-up prompt to fix gaps
         iv. Increment reviewCount
         v. If reviewCount >= maxReviewRuns AND still gaps:
            - Mark status → "stuck"
            - Broadcast: task_updated
            - HALT entire pipeline (throw/return)
    c. Update status → "executing" (if returning from review with changes)
13. If task.autoCommit:
    a. Check for uncommitted changes in worktree
    b. Stage all and commit with configured commit prompt
14. Merge worktree:
    a. git merge from worktree branch to main
    b. Handle conflicts → if conflict, mark failed, halt
15. Delete worktree:
    a. client.experimental.worktree.remove({ body: { directory: worktreeDir } })
16. Update task status → "done", set completedAt
17. Broadcast: task_updated
```

#### Execution Loop (`run()`)

```typescript
async function run() {
  if (running) return
  running = true
  broadcast({ type: "execution_started", payload: {} })

  try {
    const batches = resolveDependencies()
    for (const batch of batches) {
      if (!running) break
      const parallelLimit = getOptions().parallelTasks
      if (batch.length <= parallelLimit) {
        await Promise.all(batch.map(t => executeTask(t)))
      } else {
        // Process in chunks of parallelLimit
        for (let i = 0; i < batch.length; i += parallelLimit) {
          if (!running) break
          const chunk = batch.slice(i, i + parallelLimit)
          await Promise.all(chunk.map(t => executeTask(t)))
        }
      }
    }
    broadcast({ type: "execution_complete", payload: {} })
  } catch (err) {
    broadcast({ type: "error", payload: { message: String(err) } })
  } finally {
    running = false
    broadcast({ type: "execution_stopped", payload: {} })
  }
}
```

#### Review Integration

Reuses the same pattern from the existing plugin:

1. Read `.opencode/easy-workflow/workflow.md` for review config (reviewAgent, maxReviewRuns)
2. Create a scratch session for review
3. Prompt the review agent with the task's goals + current worktree state
4. Parse the text response (STATUS/SUMMARY/GAPS/RECOMMENDED_PROMPT format)
5. If gaps found, send recommended prompt back to task's session
6. Increment review count, check against maxReviewRuns

**Key difference from current plugin:** The review happens in a dedicated scratch session, not in the event hook. The orchestrator drives the review loop directly.

#### Stuck Task Handling

When a task hits max reviews with unresolved gaps:
1. Task status → "stuck"
2. Broadcast to all WebSocket clients (UI shows attention symbol)
3. Orchestrator throws/stops → entire pipeline halts
4. User can interact with the task in the UI:
   - "Mark as Done" button → moves to Done, resumes pipeline
   - "Move to Backlog" / drag to Backlog → resets for re-execution
5. If user resolves: pipeline continues from the next task

#### Stop Handling

```typescript
function stop() {
  running = false
  // Current task session can be aborted via client.session.abort()
  // Worktree cleanup happens in executeTask's finally block
}
```

### 5. `kanban/index.html` — Embedded UI

Single-file HTML with inline CSS and JavaScript. No build step required.

#### Layout

```
┌──────────────────────────────────────────────────────────────┐
│  [  Start  ]  Easy Workflow Kanban  [ Options ]              │
├──────────────┬──────────────┬──────────────┬─────────────────┤
│   BACKLOG    │  EXECUTING   │   REVIEW     │     DONE        │
│              │              │              │                 │
│ ┌──────────┐ │ ┌──────────┐ │ ┌──────────┐ │ ┌────────────┐ │
│ │ Task A   │ │ │ Task C   │ │ │ Task D ⚠ │ │ │ Task X     │ │
│ │ idx: 1   │ │ │ idx: 3   │ │ │ idx: 4   │ │ │ idx: 2     │ │
│ │ deps: none│ │ │ [output] │ │ │ [output] │ │ │ completed: │ │
│ └──────────┘ │ └──────────┘ │ └──────────┘ │ │ 2026-03-31 │ │
│ ┌──────────┐ │              │              │ └────────────┘ │
│ │ Task B   │ │              │              │                 │
│ │ idx: 2   │ │              │              │                 │
│ │ deps: [A]│ │              │              │                 │
│ └──────────┘ │              │              │                 │
│              │              │              │                 │
│ [+ Add Task] │              │              │                 │
└──────────────┴──────────────┴──────────────┴─────────────────┘
```

#### Card Structure (Backlog)

Each card in the Backlog column shows:
- Name (editable inline)
- Index badge (editable)
- Dependency badges (shows names of required tasks)
- Edit button (opens detail panel)
- Delete button
- Drag handle for reordering

#### Card Structure (Executing)

- Name
- Progress indicator (spinner)
- Collapsible agent output section (expand/collapse toggle)
- Live output updates via WebSocket

#### Card Structure (Review)

- Name
- Review count badge
- Attention symbol (⚠) if stuck (max reviews hit)
- Collapsible agent output section
- "Mark as Done" button (if stuck)
- Drag handle to move to Done (if stuck)

#### Card Structure (Done)

- Name
- Completion timestamp
- Collapsible agent output section

#### Task Creation Modal

Fields:
- Name (text input)
- Prompt (textarea)
- Plan Model (select: default, or text input for custom)
- Execution Model (select: default, or text input for custom)
- Plan Mode (checkbox)
- Review (checkbox, default checked)
- Auto-commit (checkbox, default checked)
- Requirements (multi-select from Backlog tasks)

#### Options Modal

Fields:
- Commit Prompt (text input, default: "feat: {{task_name}}")
- Plan Model (text input, global default)
- Execution Model (text input, global default)
- Command (text input, pre-execution shell command)
- Parallel Tasks (number input, default: 1)

#### WebSocket Client

```javascript
const ws = new WebSocket(`ws://${location.host}/ws`)
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  switch (msg.type) {
    case "task_created": addTaskCard(msg.payload); break
    case "task_updated": updateTaskCard(msg.payload); break
    case "task_deleted": removeTaskCard(msg.payload.id); break
    case "task_reordered": reorderCards(msg.payload); break
    case "agent_output": appendOutput(msg.payload.taskId, msg.payload.output); break
    case "execution_started": updateStartButton(true); break
    case "execution_stopped": updateStartButton(false); break
    case "error": showError(msg.payload.message); break
  }
}
```

#### Drag & Drop

- Backlog cards: reorder within column (updates idx via API)
- Cards can be dragged between columns (only meaningful for Backlog↔Done when stuck)
- Uses HTML5 Drag and Drop API (no library needed)

### 6. `easy-workflow.ts` — Refactored Plugin

The main plugin file becomes a thin orchestrator that:
1. Initializes the database
2. Starts the HTTP/WS server
3. Exports existing workflow hooks (chat.message, event) — UNCHANGED
4. Exposes the kanban orchestrator for start/stop

```typescript
import { initDb } from "./easy-workflow/db"
import { KanbanServer } from "./easy-workflow/server"
import { Orchestrator } from "./easy-workflow/orchestrator"

export default async ({ client, directory }: PluginInput) => {
  // Existing workflow code (unchanged)
  // ... parseWorkflowPrompt, extractGoals, runReview, etc.

  // New: Initialize kanban
  const db = initDb(join(directory, WORKFLOW_ROOT, "tasks.db"))
  const orchestrator = new Orchestrator(db, client, directory)
  const server = new KanbanServer(db, orchestrator)

  server.start() // Start HTTP/WS server

  return {
    "chat.message": existingChatMessageHook,  // unchanged
    event: existingEventHook,                  // unchanged
  }
}
```

## Execution Flow Diagram

```
User clicks "Start" in UI
        |
        v
POST /api/start --> orchestrator.run()
        |
        v
Resolve dependencies (topological sort)
        |
        v
+--- Batch 1 ----+
|  Execute Task A |--> worktree --> session --> prompt --> output
|  (no deps)      |                                        |
+-----------------+                                        |
        |                                                  |
        v                                                  v
+--- Batch 2 (parallel=2) ---+                   Review? --> Yes
|  Execute Task B (deps: A)   |                        |         |
|  Execute Task C (deps: A)   |                        v         v
+-----------------------------+                      No     Review Loop
        |                                              |    (maxReviewRuns)
        v                                              |         |
+--- Batch 3 ---+                                       |    Pass? --> Yes
|  Execute Task D |<-- deps: B, C                      |         |
|                 |                                    |         v
+-----------------+                                    |    No (stuck)
        |                                              |         |
        v                                              |    HALT PIPELINE
    Complete                                           |    Show warn in UI
                                                       v
                                              Merge worktree
                                              Delete worktree
                                              Mark done
```

## Model Resolution

```
Planning Phase:
  model = task.planModel !== "default"
    ? task.planModel
    : globalOptions.planModel !== "default"
      ? globalOptions.planModel
      : undefined  // let OpenCode choose

Execution Phase:
  model = task.executionModel !== "default"
    ? task.executionModel
    : globalOptions.executionModel !== "default"
      ? globalOptions.executionModel
      : undefined  // let OpenCode choose

Model format: "provider/model-id" (e.g., "opencode-go/kimi-k2.5")
Parsed to: { providerID: "opencode-go", modelID: "kimi-k2.5" }
```

## Implementation Order

### Phase 1: Foundation
1. `types.ts` — Define all types
2. `db.ts` — SQLite database layer
3. `kanban/index.html` — Build the kanban UI

### Phase 2: Server
4. `server.ts` — HTTP + WebSocket server
5. Wire server into plugin initialization
6. Test: UI loads, CRUD operations work via API

### Phase 3: Orchestrator
7. `orchestrator.ts` — Dependency resolution
8. `orchestrator.ts` — Task execution (worktree + session + prompt)
9. `orchestrator.ts` — Review integration
10. `orchestrator.ts` — Merge and cleanup

### Phase 4: Integration
11. Refactor `easy-workflow.ts` to import modules
12. Wire WebSocket broadcasts to orchestrator events
13. Test full end-to-end flow

### Phase 5: Polish
14. Error handling and edge cases
15. Stuck task recovery flow
16. Agent output streaming
17. Debug logging integration

## Key Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| `bun:sqlite` not available in plugin | Verified: plugins run in Bun process, `import "bun:sqlite"` works |
| Session prompt hangs | Use AbortSignal with timeout, listen for session.error events |
| Worktree merge conflicts | Detect via git exit code, mark task failed, halt pipeline |
| WebSocket connection drops | Client auto-reconnects with exponential backoff |
| Agent output too large | Truncate in UI, store full in DB, paginate if needed |
| Port conflicts | Configurable port in options, default 3789 |
| Plugin crash kills HTTP server | Server runs in try/catch, logs errors to debug.log |

## Testing Strategy

1. **Unit tests** for db.ts (CRUD, reorder, status transitions)
2. **Unit tests** for orchestrator (dependency resolution, cycle detection)
3. **Integration test** using `createOpencode` (same pattern as test-workflow.ts)
4. **Manual test** via browser: create tasks, start execution, observe kanban updates

## Backward Compatibility

- The existing `#workflow` message flow is **fully preserved**
- The review agent (`workflow-review.md`) is **unchanged**
- The workflow template (`workflow.md`) is **unchanged** (review config still read from it)
- Existing run files in `runs/` are unaffected
- The kanban system is **additive** — it runs alongside the existing workflow
