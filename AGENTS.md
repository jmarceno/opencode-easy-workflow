# About the Project
This is an Opencode (https://opencode.ai/) plugin to support review-driven workflows.

Documentation about agents, plugins, and the SDK are in `ref-docs/opencode.ai-agents.md`, `ref-docs/opencode.ai-plugins.md`, and `ref-docs/opencode.ai-sdk.md` respectively.

## How the plugin should work
- The plugin hooks into prompt submission and session idle events.
- `#workflow` is only valid when it is the first word or the last word of the prompt. Any other position is ignored and the prompt is treated as a normal prompt.
- Before validation, the prompt is normalized by trimming outer whitespace and splitting on whitespace boundaries.
- If `#workflow` is valid, the plugin removes only that boundary token and keeps the rest of the prompt unchanged for normal execution.
- If removing `#workflow` leaves an empty prompt, workflow mode is not activated.
- Workflow activation does not rewrite `.opencode/easy-workflow/workflow.md`. That file is the static template for all workflow runs.
- When workflow mode is activated, the plugin creates a new run file under `.opencode/easy-workflow/runs/`.
- The run file name is the md5 of `normalizedPrompt + createdAt`, using the prompt after removing the valid `#workflow` marker.
- The run file is created as a copy of `.opencode/easy-workflow/workflow.md` and then populated with runtime state and extracted goals.
- The run file frontmatter must include at least `runreview`, `running`, `status`, `reviewCount`, `maxReviewRuns`, `createdAt`, `updatedAt`, `sessionId`, `promptHash`, `lastReviewedAt`, and `lastReviewFingerprint`.
- `running` is a lock flag. It must be set to `true` before a review starts and must always be reset to `false` when review processing finishes, including failure paths.
- After creating the run file, the plugin sends the cleaned prompt to a structured-output extraction step that converts the task request into explicit goals.
- The extracted goals replace the `[REPLACE THIS WITH THE TASK GOALS]` section in the run file.
- The main user prompt is then executed normally in the active session.
- The plugin listens for `session.idle` events.
- On `session.idle`, the plugin locates the active run file for the session and checks whether review should run.
- A review must be skipped when any of the following is true: `runreview` is `false`, `running` is `true`, `reviewCount` has reached `maxReviewRuns`, the idle cooldown has not elapsed, or the last review result fingerprint matches the new one.
- When a review starts, the plugin uses the run file prompt and goals as the review source of truth. It should review the current codebase and branch state, not replay the full session message history.
- The review step must return structured output with a status contract such as `pass`, `gaps_found`, or `blocked`, plus a summary, identified gaps, and a recommended follow-up prompt.
- If the review returns `pass`, the plugin sets `runreview` to `false`, marks the run as completed, and leaves the run file as an audit record.
- If the review returns `gaps_found`, the plugin increments `reviewCount`, keeps `runreview` enabled, stores the returned gaps and recommended prompt, and waits for later session activity before another review attempt.
- If the review returns `blocked` or if review execution fails, the plugin sets the run status to blocked, sets `runreview` to `false`, clears `running`, and records the failure for diagnosis.
- The plugin must log important lifecycle events and should surface user-visible notifications for activation, review start, gaps found, completion, blocked state, and review-limit exhaustion.
