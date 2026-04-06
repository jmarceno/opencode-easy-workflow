# Installation

## Prerequisites

⚠️ **IMPORTANT**: You must add the plugin to your OpenCode configuration file (`~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///home/USERNAME/.config/opencode/plugins/easy-workflow.ts"]
}
```

Replace `USERNAME` with your actual username. The plugin MUST be referenced with `file://` protocol in the config file - it is NOT auto-discovered from the plugins directory.

Also ensure you do NOT have `OPENCODE_PURE=1` environment variable set, as this will prevent external plugins from loading.

## Install

Run the install script:

```bash
./install.ts install
```

This copies the following to `~/.config/opencode/`:
- Plugin: `plugins/easy-workflow.ts` (directly in plugins/, NOT in a subdirectory)
- Core: `easy-workflow/` directory (server, orchestrator, kanban UI, etc.)
- Agents: All files from `agents/` directory
- Skill: `skills/workflow-task-setup/`

## Manual Install

```bash
# Create directories
mkdir -p ~/.config/opencode/plugins
mkdir -p ~/.config/opencode/agents
mkdir -p ~/.config/opencode/skills

# Copy plugin - IMPORTANT: Copy directly to plugins/, NOT to plugins/easy-workflow/
cp easy-workflow-bridge.ts ~/.config/opencode/plugins/easy-workflow.ts

# Copy core easy-workflow files (from src/ directory)
mkdir -p ~/.config/opencode/easy-workflow/kanban
cp src/*.ts ~/.config/opencode/easy-workflow/
cp src/workflow.md ~/.config/opencode/easy-workflow/
cp src/kanban/index.html ~/.config/opencode/easy-workflow/kanban/

# Copy all agents
cp agents/*.md ~/.config/opencode/agents/

# Copy skill
cp -r skills/workflow-task-setup ~/.config/opencode/skills/

# Add to ~/.config/opencode/opencode.json:
# {
#   "$schema": "https://opencode.ai/config.json",
#   "plugin": ["file:///home/USERNAME/.config/opencode/plugins/easy-workflow.ts"]
# }
```

## Remove

```bash
./install.ts remove
```

Or manually:

```bash
rm -f ~/.config/opencode/plugins/easy-workflow.ts
rm -rf ~/.config/opencode/easy-workflow
rm ~/.config/opencode/agents/workflow-*.md ~/.config/opencode/agents/build-fast.md ~/.config/opencode/agents/deep-thinker.md
rm -rf ~/.config/opencode/skills/workflow-task-setup
```
