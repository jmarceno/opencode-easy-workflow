---
reviewAgent: workflow-review
runreview: false
running: false
status: pending
reviewCount: 0
# maxReviewRuns is now controlled by the global "Maximum Review Runs" option in the Options Modal.
# The value below is no longer read by the workflow - it is written only for backward compatibility.
maxReviewRuns: 2
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

Respond in this exact format:

STATUS: <pass|gaps_found|blocked>

SUMMARY:
<brief summary of review findings>

GAPS:
- <first gap if any>
- <second gap if any>
(or "None" if no gaps)

RECOMMENDED_PROMPT:
<specific prompt to address gaps, or "None" if no gaps>

## Task Goals

[REPLACE THIS WITH THE TASK GOALS]
