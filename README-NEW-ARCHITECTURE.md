# Easy Workflow - Standalone Server Architecture

This is the new standalone server architecture for Easy Workflow. The system has been split into two parts:

1. **Standalone Server** (`.opencode/easy-workflow/standalone.ts`) - Runs outside of OpenCode
2. **Bridge Plugin** (`.opencode/plugins/easy-workflow.ts`) - Minimal plugin that forwards events

## Quick Start

### 1. Start the Standalone Server

```bash
# From the project root
bun run start

# Or directly
bun run .opencode/easy-workflow/standalone.ts
```

On first run, it will prompt you for the OpenCode server URL:
```
Enter OpenCode server URL (e.g., http://localhost:4096):
```

This creates `.opencode/easy-workflow/config.json`:
```json
{
  "opencodeServerUrl": "http://localhost:4096",
  "projectDirectory": "/path/to/your/project"
}
```

### 2. OpenCode Plugin (Bridge)

The bridge plugin is automatically loaded by OpenCode from `.opencode/plugins/easy-workflow.ts`.

It forwards these events to the standalone server:
- `chat.message` - Detects `#workflow` keyword
- `permission.asked` - Auto-replies to permissions for workflow sessions
- `session.idle` - Triggers workflow reviews

### 3. Access the Kanban UI

Once the standalone server is running:
```
Kanban UI: http://localhost:3789 (or configured port)
```

## Architecture

```
┌─────────────┐         ┌──────────────────┐         ┌─────────────────┐
│   OpenCode  │◄───────►│  Bridge Plugin   │◄───────►│ Standalone      │
│   (App)     │  Hooks  │  (.opencode/     │  HTTP   │ Server          │
│             │         │   plugins/)      │         │ (kanban +       │
│             │         │                  │         │  orchestrator)  │
└─────────────┘         └──────────────────┘         └─────────────────┘
                                                               │
                                                               ▼
                                                        ┌──────────────┐
                                                        │   SQLite     │
                                                        │   Database   │
                                                        └──────────────┘
```

## Why This Architecture?

### Problems with the Old Plugin Architecture:

1. **Model Loading Issues** - OpenCode's model loading changes broke the plugin
2. **Hard to Debug** - Plugin errors were swallowed by OpenCode
3. **No Independent Restart** - Had to restart OpenCode to restart the workflow server
4. **Singleton Conflicts** - Multiple worktrees/shared state issues

### Benefits of the New Architecture:

1. **Independent Lifecycle** - Start/stop the workflow server independently
2. **Better Debugging** - Console logs are visible, can attach debugger
3. **No Model Loading Issues** - Server runs outside OpenCode's plugin system
4. **Clear Separation** - Bridge handles OpenCode integration, server handles business logic
5. **Configuration** - Simple JSON config file instead of env vars

## Configuration

The standalone server uses `.opencode/easy-workflow/config.json`:

```json
{
  "opencodeServerUrl": "http://localhost:4096",
  "projectDirectory": "/path/to/project"
}
```

To reconfigure, delete this file and restart the server.

## Development

### Start Standalone Server in Watch Mode

```bash
bun run dev
```

### View Debug Logs

```bash
tail -f .opencode/easy-workflow/debug.log
```

### Database

The SQLite database is at `.opencode/easy-workflow/tasks.db`.

You can inspect it with:
```bash
sqlite3 .opencode/easy-workflow/tasks.db "SELECT * FROM tasks;"
```

## Troubleshooting

### "Standalone server config not found"

The bridge plugin can't find the config. Make sure you've started the standalone server at least once to create the config file.

### "Failed to forward event"

The standalone server is not running. Start it with `bun run start`.

### Permission auto-reply not working

1. Check that the workflow session was registered: `sqlite3 .opencode/easy-workflow/tasks.db "SELECT * FROM workflow_sessions;"`
2. Check bridge plugin logs in OpenCode
3. Check standalone server logs

## Migration from v1

If you were using the old plugin architecture:

1. Delete old plugin: `rm .opencode/plugins/easy-workflow.ts`
2. The new bridge plugin will be loaded automatically
3. Run `bun run start` to create the config file
4. Your existing database and workflow runs are preserved

## API Endpoints

The standalone server exposes:

### Kanban UI
- `GET /` - Kanban board HTML
- `WS /ws` - WebSocket for real-time updates

### Tasks
- `GET /api/tasks` - List all tasks
- `POST /api/tasks` - Create task
- `GET /api/tasks/:id` - Get task
- `PATCH /api/tasks/:id` - Update task
- `DELETE /api/tasks/:id` - Delete task
- `PUT /api/tasks/reorder` - Reorder tasks

### Execution
- `POST /api/start` - Start execution
- `POST /api/stop` - Stop execution
- `POST /api/tasks/:id/start` - Start single task
- `GET /api/execution-graph` - Get execution graph

### Bridge Events
- `POST /api/events/bridge` - Receive events from bridge plugin
- `GET /api/workflow-session/:id` - Check workflow session status

### Options & Models
- `GET /api/options` - Get options
- `PUT /api/options` - Update options
- `GET /api/models` - Get model catalog from OpenCode
- `GET /api/branches` - Get git branches

## License

MIT
