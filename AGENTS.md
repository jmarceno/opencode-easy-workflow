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

Documentation about agents, plugins, and the SDK are in `ref-docs/opencode.ai-agents.md`, `ref-docs/opencode.ai-plugins.md`, and `ref-docs/opencode.ai-sdk.md` respectively.

If you need to access the Opencode source code, you can get it locally at `/home/jmarceno/Projects/cloned/opencode/`, I just pulled the most recent changes.
We are using SDK v2 that relies o opencode server, and not on opencode cli directly, so we need to start with `opencode serve` instead of just `opencode`.

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

