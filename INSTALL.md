# Installation

## Install

Run the install script:

```bash
./install.ts install
```

This copies the following to `~/.config/opencode/`:
- Plugin: `plugins/easy-workflow/easy-workflow.ts`
- Core: `easy-workflow/` directory (server, orchestrator, kanban UI, etc.)
- Agents: All files from `agents/` directory
- Skill: `skills/workflow-task-setup/`

## Manual Install

```bash
# Create directories
mkdir -p ~/.config/opencode/plugins/easy-workflow
mkdir -p ~/.config/opencode/agents
mkdir -p ~/.config/opencode/skills

# Copy plugin
cp .opencode/plugins/easy-workflow.ts ~/.config/opencode/plugins/easy-workflow/

# Copy core easy-workflow directory
cp -r .opencode/easy-workflow ~/.config/opencode/

# Copy all agents
cp .opencode/agents/*.md ~/.config/opencode/agents/

# Copy skill
cp -r .opencode/skills/workflow-task-setup ~/.config/opencode/skills/
```

## Remove

```bash
./install.ts remove
```

Or manually:

```bash
rm -rf ~/.config/opencode/plugins/easy-workflow
rm -rf ~/.config/opencode/easy-workflow
rm ~/.config/opencode/agents/workflow-*.md ~/.config/opencode/agents/build-fast.md ~/.config/opencode/agents/deep-thinker.md
rm -rf ~/.config/opencode/skills/workflow-task-setup
```
