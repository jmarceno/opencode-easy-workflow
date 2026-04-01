export type TaskStatus = "template" | "backlog" | "executing" | "review" | "done" | "failed" | "stuck"

export interface Task {
  id: string
  name: string
  idx: number
  prompt: string
  branch: string
  planModel: string
  executionModel: string
  planmode: boolean
  review: boolean
  autoCommit: boolean
  deleteWorktree: boolean
  status: TaskStatus
  requirements: string[]
  agentOutput: string
  reviewCount: number
  sessionId: string | null
  sessionUrl: string | null
  worktreeDir: string | null
  errorMessage: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export interface Options {
  commitPrompt: string
  branch: string
  planModel: string
  executionModel: string
  command: string
  parallelTasks: number
  port: number
}

export const DEFAULT_COMMIT_PROMPT = `You are in a worktree on a detached HEAD. When you are finished with the task, commit the working changes onto {{base_ref}}.

- Do not run destructive commands: git reset --hard, git clean -fdx, git worktree remove, rm/mv on repository paths.
- Do not edit files outside git workflows unless required for conflict resolution.
- Preserve any pre-existing user uncommitted changes in the base worktree.

Steps:
1. In the current task worktree, stage and create a commit for the pending task changes.
2. Find where {{base_ref}} is checked out:
   - Run: git worktree list --porcelain
   - If branch {{base_ref}} is checked out in path P, use that P.
   - If not checked out anywhere, use current worktree as P by checking out {{base_ref}} there.
3. In P, verify current branch is {{base_ref}}.
4. If P has uncommitted changes, stash them: git -C P stash push -u -m "pre-cherry-pick"
5. Cherry-pick the task commit into P.
6. If cherry-pick conflicts, resolve carefully, preserving both the intended task changes and existing user edits.
7. If a stash was created, restore it with: git -C P stash pop
8. If stash pop conflicts, resolve them while preserving pre-existing user edits.
9. Delete the worktree
10. Report:
   - Final commit hash
   - Final commit message
   - Whether stash was used
   - Whether conflicts were resolved
   - Any remaining manual follow-up needed`;

export type WSMessageType =
  | "task_created"
  | "task_updated"
  | "task_deleted"
  | "task_reordered"
  | "options_updated"
  | "execution_started"
  | "execution_stopped"
  | "execution_complete"
  | "agent_output"
  | "error"

export interface WSMessage {
  type: WSMessageType
  payload: any
}

export interface ReviewResult {
  status: "pass" | "gaps_found" | "blocked"
  summary: string
  gaps: string[]
  recommendedPrompt: string
}
