# Migration Summary: Plugin to Standalone Server Architecture

## Overview

Successfully migrated Easy Workflow from a monolithic OpenCode plugin to a **standalone server + bridge plugin** architecture.

## Changes Made

### New Files Created

1. **`.opencode/easy-workflow/standalone.ts`** (NEW)
   - Standalone server entry point
   - Auto-creates config file on first start
   - Prompts user for OpenCode server URL
   - Starts HTTP/WebSocket server
   - Initializes database and orchestrator

2. **`.opencode/plugins/easy-workflow.ts`** (REPLACED)
   - Old 1500+ line monolithic plugin → New 500 line bridge plugin
   - Forwards events to standalone server
   - Handles permission auto-reply locally (needs OpenCode client)

3. **`tsconfig.json`** (NEW)
   - TypeScript configuration for the project

4. **`.gitignore`** (NEW)
   - Ignores config.json, database files, debug logs

5. **`tests/test-architecture.ts`** (NEW)
   - Integration tests for the new architecture

6. **`README-NEW-ARCHITECTURE.md`** (NEW)
   - Detailed documentation of the new architecture

### Modified Files

1. **`.opencode/easy-workflow/server.ts`**
   - Added `/api/events/bridge` endpoint for receiving events
   - Added `/api/workflow-session/:id` endpoint for permission checks
   - Added `handleBridgeEvent()`, `handleWorkflowActivation()`, `handleOpencodeEvent()` methods
   - Removed dependency on plugin-provided server URL resolver

2. **`package.json`**
   - Added `start` and `dev` scripts
   - Added project metadata

3. **`README.md`**
   - Updated architecture diagram
   - Added quick start instructions for standalone server
   - Documented configuration system

### Backed Up Files

1. **`.opencode/plugins/easy-workflow.ts.bak`**
   - Original monolithic plugin preserved for reference

## Architecture Comparison

### Before (v1.x)
```
OpenCode → Plugin (everything inside)
  - Event hooks
  - HTTP server
  - Database
  - Orchestrator
  - All business logic
```

### After (v2.0)
```
OpenCode → Bridge Plugin (minimal, ~500 lines)
  - Forward events
  - Permission auto-reply
  ↓ HTTP
Standalone Server (outside OpenCode)
  - HTTP/WebSocket server
  - Database
  - Orchestrator
  - All business logic
```

## Benefits

1. **No Model Loading Issues** - Server runs outside OpenCode's plugin system
2. **Independent Lifecycle** - Start/stop without restarting OpenCode
3. **Better Debugging** - Console logs and errors are visible
4. **Configuration** - Simple JSON config file (`.opencode/easy-workflow/config.json`)
5. **Clear Separation** - Bridge handles OpenCode integration, server handles logic

## Configuration

The standalone server uses `.opencode/easy-workflow/config.json`:

```json
{
  "opencodeServerUrl": "http://localhost:4096",
  "projectDirectory": "/path/to/project"
}
```

Auto-created on first server start with interactive prompt.

## Quick Start

```bash
# Start standalone server (creates config on first run)
bun run start

# Or in development mode with watch
bun run dev

# Access kanban UI
open http://localhost:3789
```

## API Endpoints

### Bridge Events
- `POST /api/events/bridge` - Receive events from bridge plugin
- `GET /api/workflow-session/:id` - Check if session is workflow-owned

### Existing Endpoints (unchanged)
- `GET /api/tasks` - List tasks
- `POST /api/tasks` - Create task
- `GET /api/options` - Get options
- `GET /api/models` - Get model catalog
- etc.

## Testing

Run the architecture tests:
```bash
bun run tests/test-architecture.ts
```

## Known Limitations / TODO

1. **Workflow Run Creation** - The `handleWorkflowActivation()` method in `server.ts` is a minimal implementation. Full goal extraction and workflow run logic needs to be ported from the original plugin.

2. **Session Idle Reviews** - The `handleSessionIdle()` method is a placeholder. Full review logic needs to be ported.

3. **Toast Notifications** - Toast notifications via `client.tui.showToast()` are no longer available in standalone mode. Use Telegram notifications instead.

4. **Root Owner Pointer** - Worktree support for git worktrees needs testing in the new architecture.

## Migration Path

For users upgrading from v1.x:

1. ✅ Your existing database (`tasks.db`) is preserved
2. ✅ Your existing workflow runs (`.opencode/easy-workflow/runs/*.md`) are preserved
3. ✅ Your agents and configuration are preserved
4. ⚠️ You need to start the standalone server (`bun run start`)
5. ⚠️ You need to configure the OpenCode server URL on first run

## Rollback

To rollback to v1.x:
1. Stop the standalone server
2. Restore the old plugin: `mv .opencode/plugins/easy-workflow.ts.bak .opencode/plugins/easy-workflow.ts`
3. Delete the new files if desired
4. Restart OpenCode

## Next Steps

1. Port full workflow run creation logic from `easy-workflow.ts.bak`
2. Port session idle review logic
3. Add more comprehensive tests
4. Consider adding a daemon mode for the standalone server
5. Consider adding a systemd service file for production deployments
