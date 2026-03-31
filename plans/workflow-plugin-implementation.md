# Workflow Plugin Implementation Plan

## Target file layout

`AGENTS.md`
- Project-level behavior specification for the plugin.
- Must stay aligned with the implemented behavior.

`.opencode/plugins/easy-workflow.ts`
- Main plugin entrypoint.
- Registers prompt and event hooks.
- Owns workflow activation, run discovery, idle review orchestration, logging, and toast notifications.

`.opencode/easy-workflow/workflow.md`
- Static workflow template.
- Defines the reusable review prompt body and the placeholder goals section.
- Must not be used as mutable runtime state.

`.opencode/easy-workflow/runs/`
- Runtime storage directory for workflow run files.
- Each run file name is `<md5>.md`, where md5 is computed from `normalizedPrompt + createdAt`.

`.opencode/package.json`
- Optional dependency container for project-local plugin dependencies.
- Add only if implementation needs a frontmatter parser or other external package.

`.opencode/agents/`
- Optional location for dedicated agent definitions if implementation later needs explicit custom agents.
- Do not assume this is required unless SDK validation proves agent targeting is necessary and supported.

`plans/workflow-plugin-implementation.md`
- Technical execution document for implementers.

## `.opencode/plugins/easy-workflow.ts`

Implement the plugin as a single exported plugin function.

Required responsibilities:
- Subscribe to prompt append handling.
- Subscribe to session lifecycle events, at minimum `session.idle`.
- Read and write workflow template and run files.
- Invoke structured extraction and structured review prompts through the SDK client.
- Maintain workflow run state transitions.
- Emit logs through `client.app.log()`.
- Emit user notifications through `client.tui.showToast()` where appropriate.

Internal module structure:
- Keep helpers local to the file unless the implementation becomes unmanageably large.
- Prefer pure helpers for prompt parsing, hash input generation, frontmatter updates, and review gating checks.

Suggested helper set:
- `parseWorkflowPrompt(input: string)`
  - Trim outer whitespace.
  - Split on whitespace.
  - Accept `#workflow` only when it is the first token or the last token.
  - Remove only the valid boundary token.
  - Return `{ valid, cleanedPrompt, normalizedPrompt }`.
- `createRunHash(normalizedPrompt: string, createdAt: string)`
  - Hash `normalizedPrompt + createdAt` with md5.
- `getRunPath(promptHash: string)`
  - Resolve `.opencode/easy-workflow/runs/<promptHash>.md`.
- `ensureWorkflowDirectories()`
  - Ensure `.opencode/easy-workflow/` and `.opencode/easy-workflow/runs/` exist.
- `loadTemplate()`
  - Read `.opencode/easy-workflow/workflow.md`.
- `createRunFile(template: string, state: WorkflowRunState)`
  - Copy template content.
  - Replace frontmatter with runtime frontmatter.
  - Preserve the placeholder section for subsequent goal insertion.
- `extractGoals(sessionId: string, cleanedPrompt: string)`
  - Call `client.session.prompt()` with structured output schema.
  - Return normalized goals data.
- `writeGoalsToRunFile(runPath: string, goals: ExtractedGoals)`
  - Replace `[REPLACE THIS WITH THE TASK GOALS]`.
  - Update frontmatter timestamps and state.
- `findActiveRunForSession(sessionId: string)`
  - Scan `.opencode/easy-workflow/runs/`.
  - Return the active run matching `sessionId` and `runreview: true`.
- `shouldRunReview(state: WorkflowRunState, now: string)`
  - Enforce `running`, `maxReviewRuns`, cooldown, and duplicate-result checks.
- `runReview(sessionId: string, runFile: WorkflowRunFile)`
  - Send review prompt using the run file prompt and goals.
  - Do not inject full session message history.
  - Review is based on the current codebase and workflow goals.
- `finalizeReviewResult(runPath: string, result: ReviewResult)`
  - Update frontmatter and persisted review content.
- `withRunningLock(runPath: string, fn)`
  - Set `running: true` before execution.
  - Always clear `running` in `finally`.

Hook behavior:

Prompt hook:
- Inspect the current prompt text from the hook payload.
- Ignore prompts without a valid boundary `#workflow` marker.
- If valid:
  - compute `createdAt`
  - derive `cleanedPrompt`
  - create prompt hash from `normalizedPrompt + createdAt`
  - create run file from template
  - extract goals with structured output
  - populate the run file
  - mutate outgoing prompt to remove the marker only

Idle event hook:
- Read session identifier from the event payload.
- Find the active run for the session.
- Skip if no active run exists.
- Skip if review gates fail.
- Acquire the running lock.
- Execute the review prompt.
- Persist result.
- Release the running lock.

Failure handling:
- Any error during activation or review must be logged.
- If a run file was created but activation fails before it becomes valid, mark it blocked and persist the failure state.
- If review fails, set `status: blocked`, `runreview: false`, and `running: false`.
- If a stale run file is found with `running: true`, recover by clearing the flag only when the implementation can prove the process is stale.

## `.opencode/easy-workflow/workflow.md`

Keep this file as a static template.

Required contents:
- Frontmatter fields that are safe for template defaults.
- Prompt body that explains the review contract.
- Explicit placeholder section:
  - `[REPLACE THIS WITH THE TASK GOALS]`

Template constraints:
- Do not treat template frontmatter as live run state.
- `running` must exist in the template defaults so copied files have a known shape.
- The review instructions must require structured output.
- The review instructions must direct the reviewer to inspect the current codebase and branch state instead of replaying session history.

Recommended template frontmatter shape:
```yaml
---
runreview: false
running: false
status: pending
reviewCount: 0
maxReviewRuns: 2
createdAt: null
updatedAt: null
sessionId: null
promptHash: null
lastReviewedAt: null
lastReviewFingerprint: null
version: 1
---
```

## `.opencode/easy-workflow/runs/*.md`

Each run file must contain:
- Full copied review prompt body from the template.
- Runtime frontmatter.
- Extracted goals replacing the placeholder.
- Optional persisted review result sections for later inspection.

Required frontmatter fields:
- `runreview: boolean`
- `running: boolean`
- `status: pending | running | completed | blocked`
- `reviewCount: number`
- `maxReviewRuns: number`
- `createdAt: string`
- `updatedAt: string`
- `sessionId: string`
- `promptHash: string`
- `lastReviewedAt: string | null`
- `lastReviewFingerprint: string | null`
- `version: number`

Optional persisted fields:
- `lastReviewStatus`
- `lastRecommendedPrompt`
- `lastGapCount`

Review result persistence:
- Append or replace dedicated sections after the main prompt body.
- Keep format deterministic so the plugin can update it safely.

## `.opencode/package.json`

Create this file only if implementation requires external dependencies.

Use cases:
- YAML/frontmatter parsing library.
- Hash helper if Bun/Node built-ins are not used.

Do not add dependencies when native platform APIs are sufficient.

## Activation flow

1. Receive prompt hook payload.
2. Parse for boundary-only `#workflow`.
3. Exit early if invalid or absent.
4. Remove the valid boundary marker and validate that content remains.
5. Generate `createdAt`.
6. Generate `promptHash = md5(normalizedPrompt + createdAt)`.
7. Ensure workflow directories exist.
8. Read template file.
9. Create run file with initialized frontmatter:
   - `runreview: true`
   - `running: false`
   - `status: pending`
   - `reviewCount: 0`
   - `maxReviewRuns: 2` unless overridden later
   - `createdAt`
   - `updatedAt: createdAt`
   - `sessionId`
   - `promptHash`
10. Run structured goal extraction against the cleaned prompt.
11. Replace the goals placeholder with the extracted goals.
12. Update the outgoing prompt so the main session receives the cleaned prompt only.
13. Notify the user that workflow review mode has been enabled.

## Goal extraction contract

Use `client.session.prompt()` with structured JSON output.

Minimum schema:
```json
{
  "type": "object",
  "properties": {
    "summary": { "type": "string" },
    "goals": {
      "type": "array",
      "items": { "type": "string" }
    }
  },
  "required": ["summary", "goals"]
}
```

Extraction prompt requirements:
- Convert the cleaned user request into explicit, implementation-reviewable goals.
- Keep goals concrete and testable.
- Avoid adding requirements not implied by the user request.

Failure behavior:
- If structured extraction fails, mark the run file blocked.
- Do not leave `runreview: true` on a broken activation.

## Review flow

1. Receive `session.idle` event.
2. Identify the session.
3. Find the active run file for the session.
4. Exit if no run is active.
5. Load frontmatter and enforce review gates.
6. Set `running: true` and `status: running`.
7. Read the run file prompt and extracted goals.
8. Execute the review prompt through `client.session.prompt()` with structured output.
9. Review must rely on the run file instructions and current codebase state only.
10. Persist the review result.
11. Update counters, timestamps, and fingerprint data.
12. Clear `running`.

Review gates:
- Skip when `runreview` is `false`.
- Skip when `running` is `true`.
- Skip when `reviewCount >= maxReviewRuns`.
- Skip when cooldown since `lastReviewedAt` has not elapsed.
- Skip when the new review fingerprint matches `lastReviewFingerprint`.

## Review result contract

Use structured output with a minimum schema:
```json
{
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "enum": ["pass", "gaps_found", "blocked"]
    },
    "summary": { "type": "string" },
    "gaps": {
      "type": "array",
      "items": { "type": "string" }
    },
    "recommendedPrompt": { "type": "string" }
  },
  "required": ["status", "summary", "gaps", "recommendedPrompt"]
}
```

Result handling:
- `pass`
  - set `runreview: false`
  - set `status: completed`
  - set `lastReviewedAt`
  - persist summary and empty gaps
- `gaps_found`
  - increment `reviewCount`
  - set `runreview: true`
  - set `status: pending`
  - set `lastReviewedAt`
  - persist gaps and recommended prompt
- `blocked`
  - set `runreview: false`
  - set `status: blocked`
  - set `lastReviewedAt`
  - persist blocking reason in the summary field

`running` must be reset to `false` in all three cases.

## Fingerprinting and duplicate suppression

Compute a stable review fingerprint from persisted review result content.

Minimum input:
- review `status`
- normalized `summary`
- normalized `gaps`
- normalized `recommendedPrompt`

Use the fingerprint to suppress immediate repeated reviews that produce the same result.

## Logging and user notifications

Log these events with `client.app.log()`:
- workflow activation requested
- workflow activation succeeded
- goal extraction failed
- review started
- review skipped with reason
- review completed with status
- run blocked due to error

Show toasts for:
- workflow mode enabled
- review started
- gaps found
- workflow completed
- workflow blocked
- review limit reached

Do not emit repeated toasts for skipped idle events caused by cooldown or duplicate suppression.

## State transitions

Allowed state transitions:
- `pending -> running`
- `running -> pending`
- `running -> completed`
- `running -> blocked`
- `pending -> blocked`

Disallowed behavior:
- starting a new review while `running: true`
- leaving `running: true` after any terminal or error path
- rewriting the shared template as live state

## Implementation validation steps

Validate the exact hook payloads used by:
- `tui.prompt.append`
- `session.idle`

Validate the exact SDK request shape for structured output on `client.session.prompt()`.

Validate the safest way to mutate the prompt content inside the prompt hook.

Validate the event payload field that identifies the current session.

## Repository updates required by this plan

Update `AGENTS.md` to match the run-file model and boundary token rules.

Update `.opencode/easy-workflow/workflow.md` so it is a static template with runtime-compatible frontmatter defaults and review instructions aligned with the structured-output contract.

Create `.opencode/plugins/easy-workflow.ts`.

Create `.opencode/easy-workflow/runs/` during runtime if it does not exist.
