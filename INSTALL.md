# Easy Workflow Plugin - Installation Guide

The Easy Workflow plugin provides two modes of operation:
1. **Workflow Review Mode** - Review-driven workflow with `#workflow` trigger
2. **Kanban Orchestrator Mode** - Task orchestration with dependency management

## Prerequisites

- **OpenCode** (https://opencode.ai) installed and configured
- **Bun** runtime (https://bun.sh) - required for `bun:sqlite` support
- **Git** repository initialized in your project

### Starting the OpenCode Server

Instead of running `opencode` directly, you must start the server:

```bash
opencode serve
```

The server runs on `http://127.0.0.1:4096` by default.

### For Development

For development with auto-reload, use `bun` to run directly:

```bash
cd /path/to/your/project
opencode serve
```

### Programmatic Usage

If your project uses the SDK programmatically:

```typescript
import { createOpencode } from "@opencode-ai/sdk";

const opencode = await createOpencode({ port: 0 }); // port 0 = random available port
const { server, client } = opencode;

// Use client for API calls
const session = await client.session.create({ body: { title: "My Session" } });

// When done
server.close();
```

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

The plugin requires the OpenCode SDK v2:

```bash
bun add @opencode-ai/sdk
```

### 3. Configure the Review Agent

Edit `.opencode/agents/workflow-review.md` to set your preferred review model:

```yaml
---
mode: subagent
model: minimax/minimax-m2.7
---
```

Available models depend on your OpenCode configuration. Common options:
- `minimax/minimax-m2.7`
- `opencode-go/kimi-k2.5`
- `openai/chatgpt-5.3-codex`

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

### 5. Start OpenCode Server

Launch the OpenCode server in your project directory:

```bash
opencode serve
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
│   └── easy-workflow.ts          # Main plugin
├── agents/
│   └── workflow-review.md        # Review agent definition
├── easy-workflow/
│   ├── workflow.md               # Workflow template & config
│   ├── tasks.db                  # SQLite database (auto-created)
│   ├── debug.log                 # Debug logs (auto-created)
│   ├── db.ts                     # Database layer
│   ├── server.ts                 # HTTP/WebSocket server
│   ├── orchestrator.ts           # Task execution engine
│   ├── types.ts                  # Type definitions
│   └── kanban/
│       └── index.html            # Kanban UI
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

## Testing

Run the kanban orchestrator test:

```bash
bun test-kanban-orchestrator.ts
```

Run the workflow test:

```bash
bun test-workflow.ts
```

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

The database will be recreated on next server startup.

### Model errors

Ensure the model is available in your OpenCode instance:
```bash
opencode providers list
```

## Uninstallation

To remove the plugin:

1. Stop the OpenCode server
2. Remove plugin files:
   ```bash
   rm -rf .opencode/plugins/easy-workflow.ts
   rm -rf .opencode/easy-workflow/
   rm .opencode/agents/workflow-review.md
   ```
3. Restart the server

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