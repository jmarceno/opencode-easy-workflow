import { afterEach, describe, expect, it } from "bun:test"
import { execFileSync } from "child_process"
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { basename, join } from "path"
import { tmpdir } from "os"
import {
  WorktreeError,
  WorktreeLifecycle,
  branchExists,
  createWorktree,
  getChangedFiles,
  getDiffStats,
  getRemoteDefaultBranch,
  inspectWorktree,
  listWorktrees,
  mergeWorktree,
  parseWorktreeList,
  removeWorktree,
  resolveTargetBranch,
} from "../src/runtime/worktree.ts"

const createdDirs: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
  }).trim()
}

function createTempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-test-"))
  createdDirs.push(root)

  git(root, ["init"])
  git(root, ["checkout", "-b", "main"])

  writeFileSync(join(root, "README.md"), "# test\n", "utf-8")
  git(root, ["add", "README.md"])
  git(root, ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", "init"])

  return root
}

function commitFile(repoDir: string, relativeFilePath: string, content: string, message: string): void {
  writeFileSync(join(repoDir, relativeFilePath), content, "utf-8")
  git(repoDir, ["add", relativeFilePath])
  git(repoDir, ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", message])
}

afterEach(() => {
  for (const dir of createdDirs.splice(0, createdDirs.length)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("parseWorktreeList", () => {
  it("parses porcelain output blocks", () => {
    const parsed = parseWorktreeList([
      "worktree /tmp/repo",
      "HEAD 0123456789",
      "branch refs/heads/main",
      "",
      "worktree /tmp/repo/.worktrees/task-1",
      "HEAD abcdef0123",
      "branch refs/heads/task-1",
      "",
    ].join("\n"))

    expect(parsed.length).toBe(2)
    expect(parsed[0]?.branch).toBe("main")
    expect(parsed[1]?.branch).toBe("task-1")
  })
})

describe("worktree operations", () => {
  it("createWorktree creates a new branch worktree", async () => {
    const repo = createTempRepo()
    const info = await createWorktree({
      name: "task-1",
      branch: "task-1",
      baseRef: "main",
      baseDirectory: repo,
    })

    expect(info.branch).toBe("task-1")
    expect(existsSync(info.directory)).toBe(true)
    expect(branchExists("task-1", repo)).toBe(true)
  })

  it("createWorktree can attach to an existing branch", async () => {
    const repo = createTempRepo()
    git(repo, ["branch", "existing-branch"])

    const info = await createWorktree({
      name: "existing-branch-tree",
      branch: "existing-branch",
      baseDirectory: repo,
    })

    expect(info.branch).toBe("existing-branch")
  })

  it("createWorktree throws for invalid base ref", async () => {
    const repo = createTempRepo()

    await expect(
      createWorktree({
        name: "invalid-base",
        branch: "invalid-base",
        baseRef: "does-not-exist",
        baseDirectory: repo,
      }),
    ).rejects.toBeInstanceOf(WorktreeError)
  })

  it("listWorktrees includes main and created worktrees", async () => {
    const repo = createTempRepo()
    await createWorktree({ name: "task-a", baseDirectory: repo })
    await createWorktree({ name: "task-b", baseDirectory: repo })

    const worktrees = await listWorktrees(repo)
    const names = worktrees.map((item) => basename(item.directory))
    expect(names).toContain("task-a")
    expect(names).toContain("task-b")
    expect(worktrees.some((item) => item.isMain)).toBe(true)
  })

  it("inspectWorktree reports staged/modified/untracked files", async () => {
    const repo = createTempRepo()
    const info = await createWorktree({ name: "inspect-target", baseDirectory: repo })

    writeFileSync(join(info.directory, "README.md"), "# changed\n", "utf-8")
    writeFileSync(join(info.directory, "staged.txt"), "staged\n", "utf-8")
    writeFileSync(join(info.directory, "untracked.txt"), "untracked\n", "utf-8")
    git(info.directory, ["add", "staged.txt"])

    const status = await inspectWorktree(info.directory)
    expect(status.isClean).toBe(false)
    expect(status.modifiedFiles).toContain("README.md")
    expect(status.stagedFiles).toContain("staged.txt")
    expect(status.untrackedFiles).toContain("untracked.txt")
  })

  it("getChangedFiles and getDiffStats return meaningful metadata", async () => {
    const repo = createTempRepo()
    const info = await createWorktree({ name: "stats-target", baseDirectory: repo })

    writeFileSync(join(info.directory, "README.md"), "# changed\n", "utf-8")
    writeFileSync(join(info.directory, "new.txt"), "new\n", "utf-8")

    const changed = await getChangedFiles(info.directory)
    const stats = await getDiffStats(info.directory)

    expect(changed).toContain("README.md")
    expect(changed).toContain("new.txt")
    expect(stats.filesChanged).toBeGreaterThanOrEqual(1)
  })

  it("mergeWorktree merges into target branch in another worktree", async () => {
    const repo = createTempRepo()
    const target = await createWorktree({
      name: "dev-tree",
      branch: "dev",
      baseRef: "main",
      baseDirectory: repo,
    })
    const source = await createWorktree({
      name: "feature-tree",
      branch: "feature",
      baseRef: "main",
      baseDirectory: repo,
    })

    commitFile(source.directory, "feature.txt", "feature\n", "feature commit")

    await mergeWorktree({
      worktreeDir: source.directory,
      branch: "feature",
      targetBranch: "dev",
    })

    const mergedText = Bun.file(join(target.directory, "feature.txt")).text()
    await expect(mergedText).resolves.toBe("feature\n")
  })

  it("mergeWorktree throws when target branch is missing", async () => {
    const repo = createTempRepo()
    const source = await createWorktree({ name: "source-tree", baseDirectory: repo })

    await expect(
      mergeWorktree({
        worktreeDir: source.directory,
        branch: source.branch,
        targetBranch: "missing-target",
      }),
    ).rejects.toBeInstanceOf(WorktreeError)
  })

  it("removeWorktree removes worktree and supports no-op on missing directory", async () => {
    const repo = createTempRepo()
    const info = await createWorktree({ name: "remove-me", baseDirectory: repo })

    await removeWorktree(info.directory)
    expect(existsSync(info.directory)).toBe(false)

    await expect(removeWorktree(join(repo, "does-not-exist"))).resolves.toBeUndefined()
  })

  it("removeWorktree throws for non-worktree directory", async () => {
    const repo = createTempRepo()
    const notWorktree = join(repo, "plain-dir")
    mkdirSync(notWorktree, { recursive: true })

    await expect(removeWorktree(notWorktree)).rejects.toBeInstanceOf(WorktreeError)
  })
})

describe("branch resolution helpers", () => {
  it("resolveTargetBranch uses explicit task branch first", async () => {
    const repo = createTempRepo()
    git(repo, ["branch", "task-branch"])

    const resolved = await resolveTargetBranch({
      baseDirectory: repo,
      taskBranch: "task-branch",
      optionBranch: "main",
    })

    expect(resolved).toBe("task-branch")
  })

  it("getRemoteDefaultBranch returns null without origin", () => {
    const repo = createTempRepo()
    expect(getRemoteDefaultBranch(repo)).toBeNull()
  })
})

describe("WorktreeLifecycle", () => {
  it("creates task/run worktrees and can complete with merge+remove", async () => {
    const repo = createTempRepo()
    const lifecycle = new WorktreeLifecycle({
      baseDirectory: repo,
      worktreeBaseDir: join(repo, ".tmp-worktrees"),
    })

    const taskWorktree = await lifecycle.createForTask("abc", "task-abc")
    commitFile(taskWorktree.directory, "task.txt", "done\n", "task commit")

    const result = await lifecycle.complete(taskWorktree.directory, {
      branch: "task-abc",
      targetBranch: "main",
      shouldMerge: true,
      shouldRemove: true,
    })

    expect(result).toEqual({ merged: true, removed: true, kept: false })
    expect(existsSync(taskWorktree.directory)).toBe(false)

    const runWorktree = await lifecycle.createForRun("r1", "worker")
    expect(basename(runWorktree.directory)).toBe("worker-r1")
  })

  it("respects keepWorktrees and cleanupOrphaned prefix", async () => {
    const repo = createTempRepo()
    const lifecycle = new WorktreeLifecycle({
      baseDirectory: repo,
      keepWorktrees: true,
    })

    const kept = await lifecycle.createForTask("keep", "task-keep")
    const completion = await lifecycle.complete(kept.directory, {
      branch: "task-keep",
      targetBranch: "main",
      shouldMerge: false,
      shouldRemove: true,
    })
    expect(completion.kept).toBe(true)
    expect(existsSync(kept.directory)).toBe(true)

    await createWorktree({ name: "task-cleanup-1", baseDirectory: repo })
    await createWorktree({ name: "misc-cleanup-1", baseDirectory: repo })

    const removed = await lifecycle.cleanupOrphaned("task-cleanup")
    expect(removed.some((path) => basename(path) === "task-cleanup-1")).toBe(true)
    expect(removed.some((path) => basename(path) === "misc-cleanup-1")).toBe(false)
  })
})
