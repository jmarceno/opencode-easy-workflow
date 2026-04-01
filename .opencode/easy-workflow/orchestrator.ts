import { readFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync, unlinkSync } from "fs"
import { join } from "path"
import { fileURLToPath } from "url"
import { dirname } from "path"
import type { Task, TaskStatus, Options, ReviewResult } from "./types"
import { KanbanDB } from "./db"
import { KanbanServer } from "./server"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"

const __dirname = dirname(fileURLToPath(import.meta.url))
const WORKFLOW_ROOT = join(__dirname, "..")
const TEMPLATE_PATH = join(WORKFLOW_ROOT, "easy-workflow", "workflow.md")
const AGENTS_DIR = join(WORKFLOW_ROOT, "agents")
const DEBUG_LOG_PATH = join(WORKFLOW_ROOT, "easy-workflow", "debug.log")

// ---- SDK v2 client wrapper ----

function createV2Client(baseUrl: string, directory?: string) {
  return createOpencodeClient({
    baseUrl,
    directory,
  })
}

// ---- Utility functions (reused from existing plugin) ----

function unwrapResponseData<T>(response: any): T {
  if (response && typeof response === "object" && "data" in response) {
    return response.data as T
  }
  return response as T
}

function parseModelSelection(value: string): { providerID: string; modelID: string } | null {
  const trimmed = value.trim()
  const separatorIndex = trimmed.indexOf("/")
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) return null
  const providerID = trimmed.slice(0, separatorIndex).trim()
  const modelID = trimmed.slice(separatorIndex + 1).trim()
  return providerID && modelID ? { providerID, modelID } : null
}

function parseScalar(rawValue: string): unknown {
  if (rawValue === "null") return null
  if (rawValue === "true") return true
  if (rawValue === "false") return false
  if (/^-?\d+(?:\.\d+)?$/.test(rawValue)) return Number(rawValue)
  return rawValue
}

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return { frontmatter: {}, body: content }
  const [, frontmatterText, body] = match
  const frontmatter: Record<string, unknown> = {}
  for (const line of frontmatterText.split("\n")) {
    const separatorIndex = line.indexOf(":")
    if (separatorIndex === -1) continue
    const key = line.slice(0, separatorIndex).trim()
    const rawValue = line.slice(separatorIndex + 1).trim()
    frontmatter[key] = parseScalar(rawValue)
  }
  return { frontmatter, body }
}

function normalizeAgentName(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function appendDebugLog(kind: string, message: string, extra?: Record<string, unknown>): void {
  const payload = extra ? ` ${JSON.stringify(extra)}` : ""
  try {
    mkdirSync(join(WORKFLOW_ROOT, "easy-workflow"), { recursive: true })
    appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${kind}: ${message}${payload}\n`, "utf-8")
  } catch {}
}

function getAssistantErrorMessage(error: any): string {
  if (!error) return "Unknown error"
  if (typeof error.data?.message === "string") {
    const code = typeof error.data?.statusCode === "number" ? ` (status ${error.data.statusCode})` : ""
    return `${error.data.message}${code}`
  }
  if (typeof error.message === "string") return error.message
  return JSON.stringify(error)
}

// ---- Review config from workflow.md ----

interface ReviewConfig {
  reviewAgent: string | null
  maxReviewRuns: number
}

function loadReviewConfig(): ReviewConfig {
  if (!existsSync(TEMPLATE_PATH)) {
    return { reviewAgent: "workflow-review", maxReviewRuns: 2 }
  }
  const content = readFileSync(TEMPLATE_PATH, "utf-8")
  const { frontmatter } = parseFrontmatter(content)
  return {
    reviewAgent: normalizeAgentName(frontmatter.reviewAgent) ?? "workflow-review",
    maxReviewRuns: typeof frontmatter.maxReviewRuns === "number" ? frontmatter.maxReviewRuns : 2,
  }
}

// ---- Dependency resolution ----

function resolveBatches(tasks: Task[], parallelLimit: number): Task[][] {
  const taskMap = new Map<string, Task>()
  for (const t of tasks) taskMap.set(t.id, t)

  // Build in-degree map (only counting deps that are also in our task set)
  const inDegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const t of tasks) {
    inDegree.set(t.id, 0)
    dependents.set(t.id, [])
  }
  for (const t of tasks) {
    for (const dep of t.requirements) {
      if (taskMap.has(dep)) {
        inDegree.set(t.id, (inDegree.get(t.id) ?? 0) + 1)
        dependents.get(dep)!.push(t.id)
      }
    }
  }

  // Kahn's algorithm with level grouping
  const batches: Task[][] = []
  let queue = tasks.filter(t => (inDegree.get(t.id) ?? 0) === 0)

  while (queue.length > 0) {
    // Sort by idx within this level
    queue.sort((a, b) => a.idx - b.idx)
    batches.push([...queue])

    const nextQueue: Task[] = []
    for (const t of queue) {
      for (const depId of dependents.get(t.id) ?? []) {
        const newDeg = (inDegree.get(depId) ?? 1) - 1
        inDegree.set(depId, newDeg)
        if (newDeg === 0) {
          nextQueue.push(taskMap.get(depId)!)
        }
      }
    }
    queue = nextQueue
  }

  // Check for cycles
  const totalInBatch = batches.reduce((sum, b) => sum + b.length, 0)
  if (totalInBatch < tasks.length) {
    const stuck = tasks.filter(t => !batches.some(b => b.some(bt => bt.id === t.id)))
    throw new Error(`Circular dependency detected among: ${stuck.map(t => t.name).join(", ")}`)
  }

  // Apply parallel limit: split batches that exceed it
  const finalBatches: Task[][] = []
  for (const batch of batches) {
    if (batch.length <= parallelLimit) {
      finalBatches.push(batch)
    } else {
      for (let i = 0; i < batch.length; i += parallelLimit) {
        finalBatches.push(batch.slice(i, i + parallelLimit))
      }
    }
  }

  return finalBatches
}

// ---- Orchestrator ----

export class Orchestrator {
  private db: KanbanDB
  private server: KanbanServer
  private serverUrl: string
  private worktreeDir: string
  private running = false
  private shouldStop = false

  constructor(db: KanbanDB, server: KanbanServer, serverUrl: string, worktreeDir: string) {
    this.db = db
    this.server = server
    this.serverUrl = serverUrl
    this.worktreeDir = worktreeDir
  }

  private getClient(directory?: string) {
    return createV2Client(this.serverUrl, directory || this.worktreeDir)
  }

  private async createWorktree(name: string): Promise<any> {
    const client = this.getClient()
    const response = await client.worktree.create({
      worktreeCreateInput: { name },
    })
    if (response.error) {
      const error = response.error as any
      throw new Error(`Worktree creation failed: ${error?.message ?? JSON.stringify(error)}`)
    }
    return response.data
  }

  private async removeWorktree(directory: string): Promise<void> {
    const client = this.getClient()
    const response = await client.worktree.remove({
      worktreeRemoveInput: { directory },
    })
    if (response.error) {
      const error = response.error as any
      throw new Error(`Worktree removal failed: ${error?.message ?? JSON.stringify(error)}`)
    }
  }

  isExecuting() { return this.running }

  async start() {
    if (this.running) return

    const tasks = this.db.getTasksByStatus("backlog")
    if (tasks.length === 0) {
      throw new Error("No tasks in backlog")
    }

    this.running = true
    this.shouldStop = false
    this.server.broadcast({ type: "execution_started", payload: {} })

    try {
      const options = this.db.getOptions()
      const allTasks = this.db.getTasks()
      const batches = resolveBatches(allTasks, options.parallelTasks)

      // Filter: only process tasks that are still in backlog
      // (reorder might have changed things, but we validate deps at execution time)
      const backlogIds = new Set(tasks.map(t => t.id))

      for (const batch of batches) {
        if (this.shouldStop) break

        // Filter batch to only backlog tasks
        const readyBatch = batch.filter(t => backlogIds.has(t.id))
        if (readyBatch.length === 0) continue

        // Execute tasks in this batch (respecting parallel limit already applied)
        await Promise.all(readyBatch.map(t => this.executeTask(t, options)))

        if (this.shouldStop) break
      }

      this.server.broadcast({ type: "execution_complete", payload: {} })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      appendDebugLog("error", "orchestrator execution failed", { error: msg })
      this.server.broadcast({ type: "error", payload: { message: msg } })
    } finally {
      this.running = false
      this.server.broadcast({ type: "execution_stopped", payload: {} })
    }
  }

  stop() {
    this.shouldStop = true
  }

  private async executeTask(task: Task, options: Options) {
    if (this.shouldStop) return

    // Validate deps are done
    for (const depId of task.requirements) {
      const dep = this.db.getTask(depId)
      if (dep && dep.status !== "done") {
        const msg = `Dependency "${dep.name}" is not done (status: ${dep.status})`
        this.db.updateTask(task.id, { status: "failed", errorMessage: msg })
        const updated = this.db.getTask(task.id)!
        this.server.broadcast({ type: "task_updated", payload: updated })
        throw new Error(msg)
      }
    }

    // Mark executing
    this.db.updateTask(task.id, { status: "executing", agentOutput: "", errorMessage: null })
    let currentTask = this.db.getTask(task.id)!
    this.server.broadcast({ type: "task_updated", payload: currentTask })

    let worktreeInfo: any = null
    let sessionId: string | null = null
    const client = this.getClient()

    try {
      // 1. Create worktree
      appendDebugLog("info", "creating worktree", { taskId: task.id, taskName: task.name })
      worktreeInfo = await this.createWorktree(`task-${task.id}`)
      this.db.updateTask(task.id, { worktreeDir: worktreeInfo.directory })
      currentTask = this.db.getTask(task.id)!
      this.server.broadcast({ type: "task_updated", payload: currentTask })

      // 2. Pre-execution command (using Bun shell directly)
      const command = options.command?.trim()
      if (command && worktreeInfo?.directory) {
        appendDebugLog("info", "running pre-execution command", { taskId: task.id, command })
        try {
          const proc = Bun.spawn(["sh", "-c", command], {
            cwd: worktreeInfo.directory,
            stdout: "pipe",
            stderr: "pipe",
          })
          const output = await new Response(proc.stdout).text()
          const error = await new Response(proc.stderr).text()
          const exitCode = await proc.exited
          
          if (output) {
            this.db.appendAgentOutput(task.id, `[command stdout] ${output}\n`)
            this.server.broadcast({ type: "agent_output", payload: { taskId: task.id, output: `[command stdout] ${output}\n` } })
          }
          if (error) {
            this.db.appendAgentOutput(task.id, `[command stderr] ${error}\n`)
            this.server.broadcast({ type: "agent_output", payload: { taskId: task.id, output: `[command stderr] ${error}\n` } })
          }
          if (exitCode !== 0) {
            throw new Error(`Command failed with exit code ${exitCode}`)
          }
        } catch (cmdErr) {
          const msg = cmdErr instanceof Error ? cmdErr.message : String(cmdErr)
          appendDebugLog("warn", "pre-execution command failed", { taskId: task.id, error: msg })
          this.db.appendAgentOutput(task.id, `[command error] ${msg}\n`)
        }
      }

      // 3. Create session
      const sessionResponse = await client.session.create({
        body: { title: `Task: ${task.name}` },
      })
      const session = unwrapResponseData<any>(sessionResponse)
      sessionId = session?.id
      if (!sessionId) {
        throw new Error("Failed to create session")
      }
      this.db.updateTask(task.id, { sessionId })
      currentTask = this.db.getTask(task.id)!

      // 4. Determine model
      const executionModel = task.executionModel !== "default"
        ? task.executionModel
        : options.executionModel !== "default"
          ? options.executionModel
          : null

      const model = executionModel ? parseModelSelection(executionModel) : undefined

      // 5. Execute: plan mode or direct
      if (task.planmode) {
        const planModel = task.planModel !== "default"
          ? task.planModel
          : options.planModel !== "default"
            ? options.planModel
            : null

        const planModelParsed = planModel ? parseModelSelection(planModel) : undefined

        // Planning phase
        appendDebugLog("info", "plan mode: sending planning prompt", { taskId: task.id })
        const planResponse = await client.session.prompt({
          path: { sessionID: sessionId },
          body: {
            agent: "plan",
            model: planModelParsed,
            parts: [{ type: "text", text: task.prompt }],
          },
        })
        const planResult = unwrapResponseData<any>(planResponse)
        const planOutput = this.extractTextOutput(planResult)
        if (planOutput) {
          this.db.appendAgentOutput(task.id, `[plan] ${planOutput}\n`)
          this.server.broadcast({ type: "agent_output", payload: { taskId: task.id, output: `[plan] ${planOutput}\n` } })
        }

        // Execution phase (continue in same session)
        appendDebugLog("info", "plan mode: sending execution prompt", { taskId: task.id })
        const execResponse = await client.session.prompt({
          path: { sessionID: sessionId },
          body: {
            model,
            parts: [{ type: "text", text: "Now implement the plan. Execute all changes." }],
          },
        })
        const execResult = unwrapResponseData<any>(execResponse)
        const execOutput = this.extractTextOutput(execResult)
        if (execOutput) {
          this.db.appendAgentOutput(task.id, `[exec] ${execOutput}\n`)
          this.server.broadcast({ type: "agent_output", payload: { taskId: task.id, output: `[exec] ${execOutput}\n` } })
        }
      } else {
        // Direct execution
        appendDebugLog("info", "sending task prompt", { taskId: task.id })
        const response = await client.session.prompt({
          path: { sessionID: sessionId },
          body: {
            model,
            parts: [{ type: "text", text: task.prompt }],
          },
        })
        const result = unwrapResponseData<any>(response)
        const output = this.extractTextOutput(result)
        if (output) {
          this.db.appendAgentOutput(task.id, output)
          this.server.broadcast({ type: "agent_output", payload: { taskId: task.id, output } })
        }
      }

      // Refresh task state
      currentTask = this.db.getTask(task.id)!
      if (this.shouldStop) return

      // 6. Review loop
      if (currentTask.review) {
        const reviewConfig = loadReviewConfig()
        await this.runReviewLoop(currentTask, sessionId, reviewConfig)
        currentTask = this.db.getTask(task.id)!
        if (currentTask.status === "stuck") {
          // Task is stuck - halt pipeline
          this.shouldStop = true
          return
        }
      }

      if (this.shouldStop) return

      // 7. Commit via agent prompt (if enabled)
      if (currentTask.autoCommit && worktreeInfo) {
        try {
          appendDebugLog("info", "sending commit prompt to agent", { taskId: task.id })
          const baseRef = worktreeInfo.baseRef || worktreeInfo.branch || "main"
          const commitPromptText = options.commitPrompt.replace(/\{\{base_ref\}\}/g, baseRef)
          
          const commitResponse = await client.session.prompt({
            path: { sessionID: sessionId },
            body: {
              parts: [{ type: "text", text: commitPromptText }],
            },
          })
          const commitResult = unwrapResponseData<any>(commitResponse)
          const commitOutput = this.extractTextOutput(commitResult)
          if (commitOutput) {
            this.db.appendAgentOutput(task.id, `\n[commit] ${commitOutput}\n`)
            this.server.broadcast({ type: "agent_output", payload: { taskId: task.id, output: `\n[commit] ${commitOutput}\n` } })
          }
          appendDebugLog("info", "commit prompt completed", { taskId: task.id })
        } catch (e) {
          appendDebugLog("warn", "commit prompt failed", { taskId: task.id, error: String(e) })
          this.db.appendAgentOutput(task.id, `\n[commit error] ${String(e)}\n`)
          this.server.broadcast({ type: "agent_output", payload: { taskId: task.id, output: `\n[commit error] ${String(e)}\n` } })
        }
      }

      // 8. Merge worktree
      if (worktreeInfo) {
        try {
          appendDebugLog("info", "merging worktree", { taskId: task.id, branch: worktreeInfo.branch })
          const { execSync } = await import("child_process")

          // Get the main branch name
          let mainBranch = "main"
          try {
            const defaultBranch = execSync("git symbolic-ref refs/remotes/origin/HEAD", { encoding: "utf-8" }).trim()
            mainBranch = defaultBranch.replace("refs/remotes/origin/", "")
          } catch {
            try {
              const branches = execSync("git branch --list main master", { encoding: "utf-8" }).trim()
              if (branches.includes("main")) mainBranch = "main"
              else if (branches.includes("master")) mainBranch = "master"
            } catch {}
          }

          execSync(`cd "${worktreeInfo.directory}" && git checkout ${mainBranch} 2>/dev/null || true`, { encoding: "utf-8" })
          execSync(`cd "${worktreeInfo.directory}" && git merge ${worktreeInfo.branch} --no-edit`, { encoding: "utf-8" })
        } catch (mergeErr) {
          const msg = `Merge failed: ${mergeErr instanceof Error ? mergeErr.message : String(mergeErr)}`
          this.db.updateTask(task.id, { status: "failed", errorMessage: msg })
          const updated = this.db.getTask(task.id)!
          this.server.broadcast({ type: "task_updated", payload: updated })
          this.shouldStop = true
          return
        }
      }

      // 9. Delete worktree
      if (worktreeInfo?.directory) {
        try {
          await this.removeWorktree(worktreeInfo.directory)
        } catch (e) {
          appendDebugLog("warn", "worktree cleanup failed", { taskId: task.id, error: String(e) })
        }
      }

      // 10. Mark done
      const now = Math.floor(Date.now() / 1000)
      this.db.updateTask(task.id, { status: "done", completedAt: now, worktreeDir: null })
      const doneTask = this.db.getTask(task.id)!
      this.server.broadcast({ type: "task_updated", payload: doneTask })
      appendDebugLog("info", "task completed", { taskId: task.id, taskName: task.name })

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      appendDebugLog("error", "task execution failed", { taskId: task.id, error: msg })
      this.db.updateTask(task.id, { status: "failed", errorMessage: msg })
      const updated = this.db.getTask(task.id)!
      this.server.broadcast({ type: "task_updated", payload: updated })

      // Cleanup worktree on failure
      if (worktreeInfo?.directory) {
        try {
          await this.removeWorktree(worktreeInfo.directory)
        } catch {}
      }

      this.shouldStop = true
      throw err
    } finally {
      // Cleanup session
      if (sessionId) {
        try {
          await client.session.delete({ path: { sessionID: sessionId } })
        } catch {}
      }
    }
  }

  private async runReviewLoop(task: Task, sessionId: string, config: ReviewConfig) {
    if (!config.reviewAgent) {
      appendDebugLog("warn", "no review agent configured, skipping review", { taskId: task.id })
      return
    }

    const maxRuns = config.maxReviewRuns
    let reviewCount = task.reviewCount
    const client = this.getClient()

    // Create a temporary review file for this task
    const reviewFilePath = join(WORKFLOW_ROOT, "easy-workflow", `review-${task.id}.md`)
    const goalsContent = `## Task Goals\n\n${task.prompt}\n\n## Task Name\n\n${task.name}`
    const reviewContent = readFileSync(TEMPLATE_PATH, "utf-8")
      .replace("[REPLACE THIS WITH THE TASK GOALS]", goalsContent)

    try {
      writeFileSync(reviewFilePath, reviewContent, "utf-8")

      while (reviewCount < maxRuns && !this.shouldStop) {
        // Move to review column
        this.db.updateTask(task.id, { status: "review", reviewCount })
        const reviewTask = this.db.getTask(task.id)!
        this.server.broadcast({ type: "task_updated", payload: reviewTask })

        appendDebugLog("info", "running review", { taskId: task.id, reviewCount, maxRuns })

        // Run review in a scratch session
        const reviewSessionResponse = await client.session.create({
          body: { title: `Review: ${task.name}` },
        })
        const reviewSession = unwrapResponseData<any>(reviewSessionResponse)
        const reviewSessionId = reviewSession?.id

        let reviewResult: ReviewResult
        try {
          const promptText = [
            `@${config.reviewAgent}`,
            "",
            "Review the current repository state against the task below.",
            "Use the task goals as the only source of truth.",
            "Do not rely on prior session history.",
            "Inspect the current codebase and branch state.",
            "",
            `Task: ${task.name}`,
            `Goals: ${task.prompt}`,
          ].join("\n")

          const response = await client.session.prompt({
            path: { sessionID: reviewSessionId },
            body: {
              agent: config.reviewAgent,
              parts: [{ type: "text", text: promptText }],
            },
          })

          const result = unwrapResponseData<any>(response)
          reviewResult = this.parseReviewResponse(result)
        } finally {
          if (reviewSessionId) {
            await client.session.delete({ path: { sessionID: reviewSessionId } }).catch(() => {})
          }
        }

        appendDebugLog("info", "review result", {
          taskId: task.id,
          status: reviewResult.status,
          gaps: reviewResult.gaps,
        })

        if (reviewResult.status === "pass") {
          // Review passed
          this.db.updateTask(task.id, { status: "executing", reviewCount })
          const updated = this.db.getTask(task.id)!
          this.server.broadcast({ type: "task_updated", payload: updated })
          return
        }

        if (reviewResult.status === "blocked") {
          // Review blocked
          this.db.updateTask(task.id, {
            status: "stuck",
            reviewCount,
            errorMessage: `Review blocked: ${reviewResult.summary}`,
          })
          const updated = this.db.getTask(task.id)!
          this.server.broadcast({ type: "task_updated", payload: updated })
          return
        }

        // gaps_found - try to fix
        reviewCount++
        this.db.updateTask(task.id, { reviewCount })

        if (reviewCount >= maxRuns) {
          // Max reviews reached - stuck
          this.db.updateTask(task.id, {
            status: "stuck",
            reviewCount,
            errorMessage: `Max reviews (${maxRuns}) reached. Gaps: ${reviewResult.gaps.join("; ")}`,
          })
          const updated = this.db.getTask(task.id)!
          this.server.broadcast({ type: "task_updated", payload: updated })
          return
        }

        // Send fix prompt to the task session
        const fixPrompt = reviewResult.recommendedPrompt
          || `Fix the following issues found during review:\n${reviewResult.gaps.map(g => `- ${g}`).join("\n")}`

        appendDebugLog("info", "sending fix prompt after review", { taskId: task.id, reviewCount })
        const fixResponse = await client.session.prompt({
          path: { sessionID: sessionId },
          body: {
            parts: [{ type: "text", text: fixPrompt }],
          },
        })
        const fixResult = unwrapResponseData<any>(fixResponse)
        const fixOutput = this.extractTextOutput(fixResult)
        if (fixOutput) {
          this.db.appendAgentOutput(task.id, `\n[review-fix-${reviewCount}] ${fixOutput}\n`)
          this.server.broadcast({ type: "agent_output", payload: { taskId: task.id, output: `\n[review-fix-${reviewCount}] ${fixOutput}\n` } })
        }
      }
    } finally {
      // Cleanup review file
      try {
        unlinkSync(reviewFilePath)
      } catch {}
    }
  }

  private extractTextOutput(result: any): string {
    const parts = result?.parts
    if (!Array.isArray(parts)) return ""
    return parts
      .filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("\n")
  }

  private parseReviewResponse(result: any): ReviewResult {
    const textPart = result?.parts?.find(
      (p: any) => p?.type === "text" && typeof p.text === "string"
    )
    const text = textPart?.text ?? ""

    const statusMatch = text.match(/STATUS:\s*(\w+)/i)
    const summaryMatch = text.match(/SUMMARY:\s*([\s\S]+?)(?=\nGAPS:|$)/i)
    const gapsMatch = text.match(/GAPS:\s*([\s\S]+?)(?=\nRECOMMENDED_PROMPT:|$)/i)
    const recommendedMatch = text.match(/RECOMMENDED_PROMPT:\s*([\s\S]+?)$/i)

    const statusRaw = statusMatch?.[1]?.toLowerCase().trim() || "blocked"
    const status: ReviewResult["status"] =
      statusRaw === "pass" ? "pass" :
      statusRaw === "gaps_found" ? "gaps_found" : "blocked"

    const summary = summaryMatch?.[1]?.trim() || "Review could not be completed"

    const gapsText = gapsMatch?.[1] || ""
    const gaps = gapsText
      .split("\n")
      .map((l: string) => l.trim())
      .filter((l: string) => l.startsWith("- ") || l.startsWith("* "))
      .map((l: string) => l.replace(/^[-*]\s+/, "").trim())
      .filter((g: string) => g.length > 0 && g.toLowerCase() !== "none")

    const recommendedPrompt = recommendedMatch?.[1]?.trim() || ""
    return {
      status,
      summary,
      gaps,
      recommendedPrompt: recommendedPrompt.toLowerCase() === "none" ? "" : recommendedPrompt,
    }
  }
}
