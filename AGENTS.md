# About the Project
This is an Opencode (https://opencode.ai/) plugin to allow the easier creation of workflows.

Documentation about agents and plugins are in `ref-docs/opencode.ai-agents.md` and `ref-docs/opencode.ai-plugins.md` respectively.

## How the plugin should work:
- When a prompt is first sent, if the prompt ends with `#workflow` that prompt is first sent to a subagent that will recover the goals of the prompt and sent write them into `.opencode/easy-workflow/workflow.md` replacing the designated section `[REPLACE THIS WITH THE TASK GOALS]` and `runreview` is set to `true` at the same document, otherwise, if no `#workflow` exists, `runreview` is set to `false.
- `#workflow` is them removed from the prompt
- Prompt is run normally
- Plugin listens for session idle event
- When the session idle event happens and `runreview` is true, a subagent is them called and the prompt inside `.opencode/easy-workflow/workflow.md` is run.
- If the subagent find any gaps, it them return a prompt with the gaps and the plan to fix (this is the output asked in the prompt at `.opencode/easy-workflow/workflow.md`), if no gaps are found, plugin sets `runreview` to `false`, clear the goals at ``.opencode/easy-workflow/workflow.md` with `[REPLACE THIS WITH THE TASK GOALS]` and return.