import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { PiKanbanDB } from "../src/db.ts"
import { runStartupRecovery } from "../src/recovery/startup-recovery.ts"

const tempDirs: string[] = []

function createTempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(root)
  return root
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("startup recovery", () => {
  it("repairs stale executing tasks and fails orphaned sessions", async () => {
    const root = createTempDir("pi-easy-workflow-startup-recovery-")
    const db = new PiKanbanDB(join(root, "tasks.db"))
    const existingWorktree = join(root, "worktree-a")
    mkdirSync(existingWorktree, { recursive: true })

    const staleTask = db.createTask({
      id: "recover-1",
      name: "Stale executing task",
      prompt: "Recover stale execution",
      status: "executing",
      planmode: false,
    })
    db.updateTask(staleTask.id, { worktreeDir: join(root, "missing-worktree") })

    const interruptedReviewTask = db.createTask({
      id: "recover-2",
      name: "Interrupted review task",
      prompt: "Recover interrupted review",
      status: "review",
      review: true,
      planmode: false,
    })
    db.updateTask(interruptedReviewTask.id, {
      status: "review",
      reviewActivity: "running",
      worktreeDir: existingWorktree,
    })

    const untouchedReviewTask = db.createTask({
      id: "recover-3",
      name: "Manual review task",
      prompt: "Do not auto recover",
      status: "review",
      review: true,
      planmode: false,
    })
    db.updateTask(untouchedReviewTask.id, { reviewActivity: "idle" })

    const oldStartedAt = Math.floor(Date.now() / 1000) - 3700
    db.createWorkflowSession({
      id: "orphan-1",
      taskId: staleTask.id,
      sessionKind: "task",
      cwd: root,
      status: "active",
      startedAt: oldStartedAt,
    })
    db.createWorkflowSession({
      id: "recent-1",
      taskId: staleTask.id,
      sessionKind: "task",
      cwd: root,
      status: "active",
      startedAt: Math.floor(Date.now() / 1000),
    })

    const broadcasts: string[] = []
    await runStartupRecovery({
      db,
      broadcast: (message) => broadcasts.push(message.type),
    })

    const recoveredTask = db.getTask(staleTask.id)
    expect(recoveredTask?.status).toBe("backlog")

    const reviewRecoveredTask = db.getTask(interruptedReviewTask.id)
    expect(reviewRecoveredTask?.status).not.toBe("review")
    expect(reviewRecoveredTask?.reviewActivity).toBe("idle")

    const unchangedTask = db.getTask(untouchedReviewTask.id)
    expect(unchangedTask?.status).toBe("review")
    expect(unchangedTask?.reviewActivity).toBe("idle")

    const orphan = db.getWorkflowSession("orphan-1")
    expect(orphan?.status).toBe("failed")
    expect(orphan?.errorMessage).toBe("Server restarted during execution")

    const recent = db.getWorkflowSession("recent-1")
    expect(recent?.status).toBe("active")
    expect(broadcasts.includes("task_updated")).toBe(true)

    db.close()
  })

  it("is idempotent when run multiple times", async () => {
    const root = createTempDir("pi-easy-workflow-startup-recovery-idempotent-")
    const db = new PiKanbanDB(join(root, "tasks.db"))

    const task = db.createTask({
      id: "recover-idempotent-1",
      name: "Idempotent stale task",
      prompt: "Idempotent recover",
      status: "executing",
      planmode: false,
    })
    db.updateTask(task.id, { worktreeDir: join(root, "missing") })

    await runStartupRecovery({ db, broadcast: () => {} })
    const first = db.getTask(task.id)
    await runStartupRecovery({ db, broadcast: () => {} })
    const second = db.getTask(task.id)

    expect(first?.status).toBe("backlog")
    expect(second?.status).toBe("backlog")
    db.close()
  })
})
