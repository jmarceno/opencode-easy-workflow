# Easy Workflow Plugin - Installation Guide

The Easy Workflow plugin provides kanban-style task orchestration with dependency-aware execution for OpenCode.

## Prerequisites

- **OpenCode** (https://opencode.ai) installed and configured
- **Bun** runtime (https://bun.sh) - the plugin requires Bun for `bun:sqlite` support
- **Git** repository initialized in your project

## Installation Steps

### 1. Copy Plugin Files

Copy the following files to your project's `.opencode/` directory:

```
.opencode/
├── plugins/
│   └── easy-workflow.ts          # Main plugin entry point
├── agents/
│   └── workflow-review.md        # Review agent configuration
├── easy-workflow/
│   ├── workflow.md               # Workflow template with review settings
│   ├── db.ts                     # SQLite database layer
│   ├── server.ts                 # HTTP + WebSocket server
│   ├── orchestrator.ts           # Task execution engine
│   ├── types.ts                  # TypeScript type definitions
│   └── kanban/
│       └── index.html            # Kanban board UI
```

### 2. Install Dependencies

The plugin requires the OpenCode SDK. If not already installed:

```bash
bun add @opencode-ai/sdk
```

Or if using npm/yarn in your project:

```bash
npm install @opencode-ai/sdk
# or
yarn add @opencode-ai/sdk
```

### 3. Configure the Review Agent

Edit `.opencode/agents/workflow-review.md` to set your preferred review model:

```yaml
---
mode: subagent
model: opencode-go/kimi-k2.5  # Change to your preferred model
---
```

Available models depend on your OpenCode configuration. Common options:
- `opencode-go/kimi-k2.5`
- `opencode-go/kimi-k2-thinking`
- `openai/gpt-4`
- `anthropic/claude-3`

### 4. Configure Workflow Settings

Edit `.opencode/easy-workflow/workflow.md` to adjust review behavior:

```yaml
---
reviewAgent: workflow-review
maxReviewRuns: 2
---
```

- `reviewAgent`: Name of the agent to use for code review
- `maxReviewRuns`: Maximum number of review iterations before marking a task as "stuck"

### 5. Start OpenCode

Launch OpenCode in your project directory:

```bash
opencode
```

The plugin will automatically:
- Initialize the SQLite database (`.opencode/easy-workflow/tasks.db`)
- Start the kanban server on port 3789 (configurable)
- Show a toast notification with the kanban board URL

### 6. Access the Kanban Board

Open your browser to:

```
http://localhost:3789
```

## Directory Structure

After installation, your `.opencode/` directory should look like this:

```
.opencode/
├── plugins/
│   └── easy-workflow.ts          # Main plugin (1098 lines)
├── agents/
│   └── workflow-review.md        # Review agent definition
├── easy-workflow/
│   ├── workflow.md               # Workflow template & config
│   ├── tasks.db                  # SQLite database (auto-created)
│   ├── debug.log                 # Debug logs (auto-created)
│   ├── db.ts                     # Database layer (273 lines)
│   ├── server.ts                 # HTTP/WebSocket server (165 lines)
│   ├── orchestrator.ts           # Task execution engine (642 lines)
│   ├── types.ts                  # Type definitions (56 lines)
│   └── kanban/
│       └── index.html            # Kanban UI (642 lines)
```

## Configuration Options

### Global Options (via API or UI)

Access via `GET/PUT /api/options`:

| Option | Default | Description |
|--------|---------|-------------|
| `commitPrompt` | `feat: {{task_name}}` | Commit message template |
| `planModel` | `default` | Global default planning model |
| `executionModel` | `default` | Global default execution model |
| `command` | `""` | Pre-execution shell command |
| `parallelTasks` | `1` | Max parallel task executions |
| `port` | `3789` | Kanban server port |

### Per-Task Settings

Each task can override global settings:

- **Plan Model**: Model for planning phase (when plan mode enabled)
- **Execution Model**: Model for task execution
- **Plan Mode**: Use OpenCode's built-in `plan` agent
- **Review**: Enable/disable automated review
- **Auto-commit**: Enable/disable automatic git commits

## Usage

### Creating Tasks

1. Open the kanban board at `http://localhost:3789`
2. Click "+ Add Task" in the Backlog column
3. Fill in:
   - **Name**: Task identifier
   - **Prompt**: Instructions for the AI agent
   - **Requirements**: Dependencies on other tasks
   - **Models**: Override global defaults if needed
   - **Options**: Enable/disable review and auto-commit

### Task Execution Flow

```
Backlog → Executing → Review (optional) → Done
                    ↓
                 Failed/Stuck
```

1. Tasks start in **Backlog**
2. Click **Start** to begin execution
3. Tasks move through columns based on status
4. Dependencies are resolved automatically (topological sort)

### Dependencies

- Tasks specify dependencies via `requirements` (array of task IDs)
- The orchestrator builds a dependency graph and executes in order
- Circular dependencies are detected and will halt execution

### Review Process

When review is enabled:
1. After task execution, a review agent evaluates the work
2. If gaps are found, a fix prompt is sent automatically
3. This repeats up to `maxReviewRuns` times
4. If max reviews reached with gaps, task is marked "stuck"

## Testing

Run the end-to-end test:

```bash
bun test-kanban-orchestrator.ts
```

This test:
1. Creates two tasks (B depends on A)
2. Disables review and auto-commit
3. Executes both tasks
4. Verifies file outputs
5. Reports success/failure

## Troubleshooting

### Plugin not loading

Check the debug log:
```bash
cat .opencode/easy-workflow/debug.log
```

### Port already in use

Change the port in options:
```bash
curl -X PUT http://localhost:3789/api/options \
  -H "Content-Type: application/json" \
  -d '{"port": 3790}'
```

### Database issues

Reset the database (WARNING: deletes all tasks):
```bash
rm .opencode/easy-workflow/tasks.db
```

The database will be recreated on next OpenCode startup.

### Model errors

Ensure the model is available in your OpenCode instance:
```bash
opencode agents list
```

## Legacy Workflow Support

The original `#workflow` prompt trigger is still supported:

```
Your task description here #workflow
```

This creates a workflow run file in `.opencode/easy-workflow/runs/` and triggers the review process on session idle.

## API Reference

The kanban server exposes a REST API:

### Tasks
- `GET /api/tasks` - List all tasks
- `POST /api/tasks` - Create task
- `PATCH /api/tasks/:id` - Update task
- `DELETE /api/tasks/:id` - Delete task
- `PUT /api/tasks/reorder` - Reorder tasks

### Options
- `GET /api/options` - Get global options
- `PUT /api/options` - Update options

### Execution
- `POST /api/start` - Start execution
- `POST /api/stop` - Stop execution

### WebSocket
- `WS /ws` - Real-time updates

## Uninstallation

To remove the plugin:

1. Stop OpenCode
2. Remove plugin files:
   ```bash
   rm -rf .opencode/plugins/easy-workflow.ts
   rm -rf .opencode/easy-workflow/
   rm .opencode/agents/workflow-review.md
   ```
3. Restart OpenCode

## Support

For issues or questions:
- Check debug logs: `.opencode/easy-workflow/debug.log`
- Review OpenCode documentation: https://opencode.ai
- Report issues: https://github.com/anomalyco/opencode/issues
