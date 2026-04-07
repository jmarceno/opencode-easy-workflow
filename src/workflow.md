---
reviewAgent: workflow-review
runreview: false
running: false
status: pending
reviewCount: 0
createdAt: null
updatedAt: null
sessionId: null
promptHash: null
lastReviewedAt: null
lastReviewFingerprint: null
version: 1
---

You are in review mode. Your objective is to verify whether all changes in this branch fulfill the task goals.

## Review Instructions

1. **Inspect the current codebase and branch state** - do NOT replay the full session message history
2. Compare the actual implementation against the extracted goals provided below
3. Determine if the goals have been fully, partially, or not achieved
4. If gaps exist, provide concrete, actionable recommendations
5. Be thorough but focused only on what the goals specify

## Response Format

Your response must be a valid JSON object matching this schema:

```json
{
  "status": "pass|gaps_found|blocked",
  "summary": "<brief summary of review findings>",
  "gaps": ["<first gap if any>", "<second gap if any>"],
  "recommendedPrompt": "<specific prompt to address gaps, or empty string if no gaps>"
}
```

- **status**: "pass" if all goals are met, "gaps_found" if issues exist, "blocked" if review cannot complete
- **summary**: Brief summary of what you found
- **gaps**: Array of specific gaps found (empty array if status is "pass")
- **recommendedPrompt**: Specific prompt to address the gaps, or empty string if no gaps

## Task Goals

[REPLACE THIS WITH THE TASK GOALS]
