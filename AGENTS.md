This is an Opencode (https://opencode.ai/) plugin to support review-driven workflows.

Documentation about agents, plugins, and the SDK are in `ref-docs/opencode.ai-agents.md`, `ref-docs/opencode.ai-plugins.md`, and `ref-docs/opencode.ai-sdk.md` respectively.

If you need to access the Opencode source code, you can get it locally at `/home/jmarceno/Projects/cloned/opencode/`, I just pulled the most recent changes.
We are using SDK v2 that relies o opencode server, and not on opencode cli directly, so we need to start with `opencode serve` instead of just `opencode`.

---

## Best Practices

1. **Always use try/finally** when creating scratch sessions to ensure cleanup
2. **Log everything** during development - use debug.log for diagnostics
3. **Check agent availability** before routing to subagents
4. **Use text parsing** as a fallback when structured output isn't available
5. **Preserve user context** - use the same agent/model from input when creating scratch sessions
6. **Handle missing data gracefully** - always provide fallback values
7. **Always run the integration tests** - always run the integration tests yourself and fix any issues.

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

