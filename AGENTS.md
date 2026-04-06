This is an Opencode (https://opencode.ai/) plugin to support review-driven workflows.

**CRITICAL WARNING - NEVER USE DEFAULT PORTS IN TESTS:**
⚠️ Using default ports (like 3789) in tests will CRASH the production server by shutting it down when tests start. ⚠️

**ALWAYS use random ports in tests:**
- For Bun servers: `Bun.serve({ port: 0 })` - port 0 assigns a random available port
- For OpenCode SDK: `createOpencode({ port: 0 })` - port 0 assigns a random available port
- Never hardcode port numbers (3000, 3789, 8080, etc.) in test files
- Never read production port settings from databases or config files in tests
- Use `getFreePort()` helper pattern from existing tests when needed

**CRITICAL WARNING - NEVER TOUCH PRODUCTION CONFIG OR PID FILES IN TESTS:**
⚠️ Tests must NEVER modify production configuration files, database files, or PID files. ⚠️

**Files that tests must NEVER touch:**
- `.opencode/easy-workflow/config.json` - Production server configuration
- `.opencode/easy-workflow/tasks.db` - Production task database  
- `.opencode/easy-workflow/.server.pid` - Production server process tracking
- Any file in the production `.opencode/easy-workflow/` directory

**How to write safe tests:**
1. **Use temporary directories**: Create test databases in `/tmp/` or use `mkdtempSync()`
2. **Copy files, don't move them**: If you need production files, copy them to temp directories
3. **Backup before testing**: Save original configs and restore them after tests
4. **Never use production paths in tests**: Don't use `process.cwd()` for database paths in tests
5. **Isolate test environments**: Each test should have its own isolated directory

**Why this matters:**
The production kanban server runs on port 3789 by default. If tests use this port or modify production files, they will:
1. Kill the production server when starting
2. Delete or corrupt production configuration
3. Cause data loss and interrupted workflows
4. Crash active user sessions
5. Break the `.server.pid` tracking, leaving orphaned processes

---

## OPENCODE PLUGIN DEVELOPMENT - CRITICAL CAVEATS

This section documents all the OpenCode plugin system quirks and requirements discovered during development. **READ THIS CAREFULLY** to avoid hours of debugging.

### 1. Plugin Registration (CRITICAL)

OpenCode does NOT auto-discover plugins from the `~/.config/opencode/plugins/` directory. You MUST manually register them.

**Correct way to register a plugin:**

Edit `~/.config/opencode/opencode.json`:
```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///home/USERNAME/.config/opencode/plugins/easy-workflow.ts"]
}
```

**IMPORTANT:**
- MUST use `file://` protocol (not just a path)
- MUST use absolute path (not relative or `~`)
- Plugin file MUST be directly in `plugins/`, NOT in a subdirectory
- Plugin filename MUST end in `.ts` (TypeScript)

**Common mistakes:**
```json
// ❌ WRONG - no file:// protocol
"plugin": ["/home/user/.config/opencode/plugins/easy-workflow.ts"]

// ❌ WRONG - relative path
"plugin": ["./plugins/easy-workflow.ts"]

// ❌ WRONG - using ~ shortcut
"plugin": ["file://~/.config/opencode/plugins/easy-workflow.ts"]

// ❌ WRONG - in subdirectory
"plugin": ["file:///home/user/.config/opencode/plugins/easy-workflow/easy-workflow.ts"]

// ✅ CORRECT
"plugin": ["file:///home/user/.config/opencode/plugins/easy-workflow.ts"]
```

### 2. OPENCODE_PURE Environment Variable (CRITICAL)

If `OPENCODE_PURE=1` is set, OpenCode will **silently skip loading ALL external plugins**.

**Check if it's set:**
```bash
env | grep PURE
```

**If set, unset it:**
```bash
unset OPENCODE_PURE
```

**To verify plugins are loading:**
```bash
opencode serve --print-logs 2>&1 | grep -E "plugin|easy-workflow"
```

You should see:
```
INFO ... service=plugin path=file:///home/.../easy-workflow.ts loading plugin
```

If you only see internal plugins (CodexAuthPlugin, CopilotAuthPlugin, etc.) and the message "skipping external plugins in pure mode", then `OPENCODE_PURE` is set.

### 3. OpenCode Passes Wrong Directory (CRITICAL)

OpenCode caches the last project directory and passes it to plugins instead of the actual current directory.

**Example:**
- You run `opencode serve` from `~/Projects/VTimeline`
- OpenCode passes `~/Projects/opencode-easy-workflow` (the previous project)
- Your plugin MUST use `process.cwd()` instead of the `directory` parameter

**Correct pattern:**
```typescript
export const MyPlugin = async (input: any) => {
  // ❌ WRONG - uses cached directory
  const { directory } = input
  
  // ✅ CORRECT - uses actual current directory
  const actualDirectory = process.cwd()
  
  // ... rest of plugin
}
```

### 4. Plugin Location (CRITICAL)

The plugin file MUST be placed directly in `~/.config/opencode/plugins/`, NOT in a subdirectory.

**Correct:**
```
~/.config/opencode/plugins/easy-workflow.ts
```

**WRONG:**
```
~/.config/opencode/plugins/easy-workflow/easy-workflow.ts
```

### 5. Spawning Subprocesses - stdin Issue

When spawning a subprocess from a plugin, the child's stdin MUST NOT try to read interactively, because the parent has `stdio: ["ignore", "pipe", "pipe"]` which means stdin is ignored.

**Problem:**
If your subprocess tries to use `readline` or `prompt()` to get user input, it will hang/fail silently.

**Solution:**
Your standalone server must auto-create any needed configuration with defaults, not prompt interactively:

```typescript
// ❌ WRONG - tries to read from stdin
async function initializeConfig() {
  const url = await prompt("Enter URL: ")  // This will hang!
}

// ✅ CORRECT - auto-create with defaults
async function initializeConfig() {
  const config = {
    opencodeServerUrl: "http://localhost:4096",
    projectDirectory: process.cwd()
  }
  saveConfig(config)
}
```

### 6. Console.log Output Is Captured

`console.log()` output from plugins does NOT appear in the terminal where you ran `opencode serve`. It is captured by OpenCode's logging system.

**To see plugin logs:**
```bash
opencode serve --print-logs 2>&1 | grep "easy-workflow"
```

**To write to a file for debugging:**
```typescript
const debugLog = (msg: string) => {
  try {
    const fs = require('fs')
    const path = require('path')
    const logPath = path.join(process.cwd(), '.opencode', 'plugin-debug.log')
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`)
  } catch (e) {
    // Ignore logging errors
  }
}
```

### 7. Project Directory Traversal Bug (FIXED in our plugin)

**Original Bug:**
The plugin's `findProjectRoot()` function used to traverse UP looking for `.opencode/easy-workflow/`, which would find wrong directories (like `~/.opencode/easy-workflow/` or parent projects).

**Our Fix:**
We now ONLY use `process.cwd()` and NEVER traverse up. The current directory is always the project root.

### 8. Config File Location Confusion

The standalone server creates its config at `{project}/.opencode/easy-workflow/config.json`, but the standalone server code itself is installed globally at `~/.config/opencode/easy-workflow/`.

**Key paths:**
- Global installation: `~/.config/opencode/easy-workflow/` (server code)
- Project config: `{cwd}/.opencode/easy-workflow/config.json` (auto-created)
- Project database: `{cwd}/.opencode/easy-workflow/tasks.db` (auto-created)

**In the bridge plugin:**
```typescript
// Server code location (global)
const globalWorkflowDir = join(homedir(), ".config", "opencode", "easy-workflow")
const standalonePath = join(globalWorkflowDir, "standalone.ts")

// Working directory (project-specific)
const projectRoot = process.cwd()

// Spawn with cwd set to project root
spawn("bun", ["run", standalonePath], { cwd: projectRoot })
```

### 9. Validation Checklist

When debugging plugin issues, verify:

1. **Plugin file exists:** `ls -la ~/.config/opencode/plugins/easy-workflow.ts`
2. **Plugin is in opencode.json:** `cat ~/.config/opencode/opencode.json | grep easy-workflow`
3. **Uses file:// protocol:** Should see `file:///home/...` not just a path
4. **OPENCODE_PURE is not set:** `env | grep PURE` should return nothing
5. **JSON is valid:** `cat ~/.config/opencode/opencode.json | python3 -m json.tool`
6. **Plugin is loading:** `opencode serve --print-logs 2>&1 | grep easy-workflow`
7. **No syntax errors:** `bun run ~/.config/opencode/plugins/easy-workflow.ts` (should exit without errors)

### 10. Common Error Messages

**"skipping external plugins in pure mode"**
- Cause: `OPENCODE_PURE=1` environment variable is set
- Fix: `unset OPENCODE_PURE`

**"Plugin file not found" or no plugin loading**
- Cause: Plugin not in opencode.json or wrong path format
- Fix: Add `"file:///home/USER/.config/opencode/plugins/easy-workflow.ts"` to plugin array

**"Standalone server not found"**
- Cause: Global easy-workflow directory not installed
- Fix: Run `./install.ts install`

**Wrong project directory (using cached value)**
- Cause: Using `input.directory` instead of `process.cwd()`
- Fix: Use `const actualDirectory = process.cwd()` in plugin

---

## Best Practices

---

## Best Practices

1. **NEVER use default ports in tests** - Always use `port: 0` for random ports (see critical warning above). This prevents tests from crashing the production server.
2. **NEVER touch production files in tests** - Always use temporary directories for test databases, configs, and artifacts. Never modify `.opencode/easy-workflow/config.json`, `tasks.db`, or `.server.pid` in tests.
3. **Always use try/finally** when creating scratch sessions to ensure cleanup
4. **Log everything** during development - use debug.log for diagnostics
5. **Check agent availability** before routing to subagents
6. **Use text parsing** as a fallback when structured output isn't available
7. **Preserve user context** - use the same agent/model from input when creating scratch sessions
8. **Handle missing data gracefully** - always provide fallback values
9. **Always run the integration tests** - always run the integration tests yourself and fix any issues.

---

## Reference Files

- Plugin implementation: `.opencode/plugins/easy-workflow.ts`
- Agent definitions: `.opencode/agents/`
- Workflow template: `.opencode/easy-workflow/workflow.md`
- Test script: `test-workflow.ts`
- OpenCode source: `/home/jmarceno/Projects/cloned/opencode/`
- SDK docs: `ref-docs/opencode.ai-sdk.md`
- Plugin docs: `ref-docs/opencode.ai-plugins.md`
- Agent docs: `ref-docs/opencode.ai-agents.md`

---

## About the Project

