---
name: workflow-task-setup
description: Convert any user-provided implementation plan or scope document into Easy Workflow kanban tasks with correct dependencies, states, and persistence.
---

## What I do

- Turn any user-provided planning material into Easy Workflow tasks.
- Map steps and milestones into executable backlog tasks or reusable templates.
- Set dependencies, ordering, and task options so the workflow can run them correctly.
- Configure `standard` vs `best_of_n` execution strategy per task when needed.
- Explain and use the workflow's API, database layout, and state model accurately.

## When to use me

- The user wants tasks created from a plan, spec, issue, notes, checklist, design doc, or any other document that describes scope, ideas, or implementation steps.
- The user wants an existing document translated into kanban tasks.
- The user wants tasks normalized, split, merged, reordered, or reconfigured before execution.

## Core Behavior

- Prefer creating tasks, not starting execution, unless the user explicitly asks to run them.
- Prefer small, outcome-based tasks that can be completed and reviewed independently.
- Keep each task prompt self-contained enough that an execution agent can act on it without needing to rediscover the original plan.
- Use dependencies for real sequencing constraints, not just because steps are numbered.
- Create template tasks only when the user wants reusable blueprints; otherwise create backlog tasks.
- Reuse or update an existing task instead of creating a duplicate when the match is clear. If the match is ambiguous, ask.
- Use `best_of_n` only for tasks where multiple candidate implementations and convergence are useful; otherwise keep `standard`.

## Recommended Workflow

1. Read the source material and extract the real deliverables, constraints, and acceptance criteria.
2. Check existing tasks before creating new ones.
3. Split the work into the smallest useful execution units.
4. Decide whether each item should be a `template` or `backlog` task.
5. Add dependencies only where one task truly blocks another.
6. Create tasks in intended execution order, or reorder them afterward.
7. Verify the stored result by listing tasks again and summarizing the mapping back to the user.

## Task Shape

Required fields for useful task creation:

| Field | Meaning |
| --- | --- |
| `name` | Short card title shown on the board |
| `prompt` | Main execution instructions |

Common optional fields:

| Field | Meaning | Normal default |
| --- | --- | --- |
| `status` | Board state | `backlog` for runnable tasks, `template` for reusable blueprints |
| `branch` | Target git branch | Global workflow default branch |
| `planModel` | Planning model override | `default` |
| `executionModel` | Execution model override | `default` |
| `planmode` | Pause after planning and wait for approval | `false` |
| `executionStrategy` | Execution mode (`standard` or `best_of_n`) | `standard` |
| `bestOfNConfig` | Best-of-N worker/reviewer/final-applier config | `null` unless strategy is `best_of_n` |
| `review` | Run review loop after implementation | `true` |
| `autoCommit` | Auto-commit on success | `true` |
| `deleteWorktree` | Remove worktree after completion | `true` |
| `requirements` | Array of blocking task ids | `[]` |
| `thinkingLevel` | Reasoning effort | `default` |

## State Model

Task status values:

| Status | Meaning |
| --- | --- |
| `template` | Reusable blueprint, not meant to execute directly |
| `backlog` | Ready for execution when dependencies are satisfied |
| `executing` | Currently running |
| `review` | Waiting for review or user attention |
| `done` | Finished successfully |
| `failed` | Execution failed |
| `stuck` | Review found unresolved gaps or the workflow could not continue |

Execution phase values:

| Phase | Meaning |
| --- | --- |
| `not_started` | Normal initial state |
| `plan_complete_waiting_approval` | Planning finished and the task is paused |
| `implementation_pending` | Plan was approved and implementation can run |
| `implementation_done` | Implementation finished |

## API Usage

Use the kanban tools to interact with tasks:

```
/task create "Task Name" "Task prompt"
/task list
/task update <task-id> status=executing
/task approve <task-id>  (for plan-mode tasks)
```

Or use the kanban_* tools directly.

## Plan-to-Task Heuristics

- If the source describes milestones, map each milestone to one or more executable tasks.
- If the source mixes research, implementation, and validation, split those into separate tasks when they can be reviewed independently.
- If one step exists only to unblock another, make it a dependency.
- If a step is optional, risky, or calls for human approval, consider `planmode = true`.
- If the user wants reusable scaffolding for future work, create `template` tasks instead of backlog tasks.
- Keep prompts explicit about files, subsystems, constraints, and verification expectations when those are available in the source.

## Validation Checklist

Before finishing, verify:

- task names are distinct and readable
- prompts are actionable
- dependencies reference real task ids
- no obvious circular dependency exists
- statuses are appropriate for the user's intent
- plan-mode tasks are only used where an approval pause is actually useful
- `best_of_n` is only used where candidate fan-out/convergence is useful
- ordering in `idx` matches the intended flow

## What to Tell the User

After setup, report:

- how many tasks you created or updated
- any templates versus backlog tasks
- any important dependencies you added
- any assumptions you made while translating the source material
- any ambiguities that still need user input
