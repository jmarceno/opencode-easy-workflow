# Pi Easy Workflow

Review-driven workflow with kanban board for pi.

## Features

- **#workflow prefix**: Start a review-driven task by typing `#workflow <task>`
- **Kanban Board**: Visual task management with `/board` command
- **Automatic Review**: Tasks are reviewed after completion
- **Multi-Agent Support**: Plan, build, review, and repair agents
- **Git Worktree Integration**: Isolated branches per task

## Installation

```bash
npm install @jmarceno/pi-easy-workflow
```

## Commands

| Command | Description |
|---------|-------------|
| `/board` | Show the kanban board |
| `/workflow status` | Check workflow status |
| `/workflow cancel <id>` | Cancel a workflow |
| `/task create "Name" "prompt"` | Create a task |
| `/task list` | List tasks |
| `/task update <id> status=backlog` | Update a task |
| `/task start <id>` | Start a task |
| `/task approve <id>` | Approve a plan-mode task |

## Tools

### Workflow Tools

| Tool | Description |
|------|-------------|
| `workflow_start` | Start a new review-driven workflow |
| `workflow_status` | Check current workflow status |
| `workflow_review` | Manually trigger a review |
| `workflow_cancel` | Cancel the current workflow |

### Kanban Tools

| Tool | Description |
|------|-------------|
| `kanban_list` | List all tasks |
| `kanban_create` | Create a new task |
| `kanban_update` | Update a task |
| `kanban_delete` | Delete a task |

## Configuration

Create a config file at `~/.pi/agent/extensions/easy-workflow.json`:

```json
{
  "enabled": true,
  "reviewAgent": "workflow-review",
  "maxReviewRuns": 2,
  "reviewCooldownMs": 30000,
  "port": 3847,
  "defaultBranch": "main",
  "planModel": "default",
  "executionModel": "default",
  "parallelTasks": 2,
  "autoCommit": true,
  "deleteWorktree": true
}
```

## Usage

### Starting a Workflow

```
#workflow Implement user authentication
```

This will:
1. Parse your task into goals
2. Set up review tracking
3. Start the workflow session

### Creating Tasks from a Plan

```
#workflow Create tasks from this plan:
1. Set up database schema
2. Implement API endpoints
3. Build frontend components
```

### Using the Kanban Board

```
/board                    # View all tasks
/task create "Auth" "Add user authentication"
/task start auth-1       # Start a task
```

## Architecture

```
pi-easy-workflow/
├── src/
│   ├── index.ts          # Extension entry point
│   ├── config.ts         # Configuration
│   ├── hooks/            # Event hooks
│   ├── tools/            # LLM tools
│   ├── commands/          # User commands
│   ├── kanban/           # Kanban system
│   ├── prompts/          # Agent prompts
│   └── skills/           # Skills
```

## Development

```bash
# Install dependencies
pnpm install

# Type check
pnpm typecheck

# Lint
pnpm lint

# Format
pnpm format
```

## License

MIT
