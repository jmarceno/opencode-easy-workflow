import type { Task } from "./types"
import { getPlanExecutionEligibility } from "./task-state"

export function getExecutableTasks(tasks: Task[]): Task[] {
  const taskMap = new Map<string, Task>()
  for (const task of tasks) taskMap.set(task.id, task)

  const seen = new Set<string>()
  const executable: Task[] = []

  for (const task of tasks) {
    if (!isTaskExecutable(task)) continue
    if (!areTaskRequirementsDone(task, taskMap)) continue
    if (seen.has(task.id)) continue
    seen.add(task.id)
    executable.push(task)
  }

  return executable
}

export function isTaskExecutable(task: Task): boolean {
  if (!getPlanExecutionEligibility(task).ok) {
    return false
  }

  const isBacklogTask = task.status === "backlog" && task.executionPhase !== "plan_complete_waiting_approval"
  const isApprovedPlanTask = task.executionPhase === "implementation_pending"
  const isRevisionPendingTask = task.executionPhase === "plan_revision_pending"
  return isBacklogTask || isApprovedPlanTask || isRevisionPendingTask
}

function areTaskRequirementsDone(task: Task, taskMap: Map<string, Task>): boolean {
  for (const depId of task.requirements) {
    const dep = taskMap.get(depId)
    if (!dep || dep.status !== "done") {
      return false
    }
  }
  return true
}

function collectTaskAndDependencyIds(taskId: string, taskMap: Map<string, Task>): string[] {
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const ordered: string[] = []

  const visit = (id: string, chain: string[]) => {
    if (visiting.has(id)) {
      const cycleStart = chain.indexOf(id)
      const cycleIds = cycleStart >= 0 ? [...chain.slice(cycleStart), id] : [...chain, id]
      const cycleNames = cycleIds.map((cycleId) => taskMap.get(cycleId)?.name ?? cycleId)
      throw new Error(`Circular dependency detected: ${cycleNames.join(" -> ")}`)
    }

    if (visited.has(id)) return

    const task = taskMap.get(id)
    if (!task) {
      throw new Error(`Task not found: ${id}`)
    }

    visiting.add(id)
    for (const depId of task.requirements) {
      if (!taskMap.has(depId)) {
        throw new Error(`Task \"${task.name}\" depends on missing task \"${depId}\"`)
      }
      visit(depId, [...chain, id])
    }
    visiting.delete(id)
    visited.add(id)
    ordered.push(id)
  }

  visit(taskId, [])
  return ordered
}

export function resolveExecutionTasks(tasks: Task[], taskId?: string): Task[] {
  if (!taskId) return getExecutableTasks(tasks)

  const taskMap = new Map<string, Task>()
  for (const task of tasks) taskMap.set(task.id, task)

  const targetTask = taskMap.get(taskId)
  if (!targetTask) {
    throw new Error(`Task not found: ${taskId}`)
  }

  const candidateIds = collectTaskAndDependencyIds(taskId, taskMap)
  const executionTasks: Task[] = []

  for (const candidateId of candidateIds) {
    const candidate = taskMap.get(candidateId)!
    if (candidate.status === "done") continue

    if (!isTaskExecutable(candidate)) {
      if (candidate.id === taskId) {
        throw new Error(
          `Task \"${candidate.name}\" is not runnable from status \"${candidate.status}\" (phase: ${candidate.executionPhase})`,
        )
      }
      throw new Error(
        `Dependency \"${candidate.name}\" is not done and cannot run from status \"${candidate.status}\" (phase: ${candidate.executionPhase})`,
      )
    }

    executionTasks.push(candidate)
  }

  if (executionTasks.length === 0) {
    throw new Error(`Task \"${targetTask.name}\" and its dependencies are already done`)
  }

  return executionTasks
}

export function resolveBatches(tasks: Task[], parallelLimit: number): Task[][] {
  const taskMap = new Map<string, Task>()
  for (const t of tasks) taskMap.set(t.id, t)

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

  const batches: Task[][] = []
  let queue = tasks.filter(t => (inDegree.get(t.id) ?? 0) === 0)

  while (queue.length > 0) {
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

  const totalInBatch = batches.reduce((sum, b) => sum + b.length, 0)
  if (totalInBatch < tasks.length) {
    const stuck = tasks.filter(t => !batches.some(b => b.some(bt => bt.id === t.id)))
    throw new Error(`Circular dependency detected among: ${stuck.map(t => t.name).join(", ")}`)
  }

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

export interface ExecutionGraph {
  batches: { idx: number; taskIds: string[]; taskNames: string[] }[]
  nodes: {
    id: string
    name: string
    status: string
    requirements: string[]
    expandedWorkerRuns?: number
    expandedReviewerRuns?: number
    hasFinalApplier?: boolean
    estimatedRunCount?: number
  }[]
  edges: { from: string; to: string }[]
  totalTasks: number
  parallelLimit: number
  pendingApprovals?: {
    id: string
    name: string
    status: string
    awaitingPlanApproval: boolean
    planRevisionCount?: number
  }[]
}

export function resolveDependencyChain(targetTaskId: string, allTasks: Task[]): Task[] {
  return resolveExecutionTasks(allTasks, targetTaskId)
}

function getExecutionGraphTasks(tasks: Task[]): Task[] {
  const taskMap = new Map<string, Task>()
  for (const task of tasks) taskMap.set(task.id, task)

  const pendingTasks = tasks.filter(task => task.status !== "done" && isTaskExecutable(task))
  const scheduledIds = new Set<string>()

  let madeProgress = true
  while (madeProgress) {
    madeProgress = false

    for (const task of pendingTasks) {
      if (scheduledIds.has(task.id)) continue

      const requirementsSatisfied = task.requirements.every(depId => {
        const dependency = taskMap.get(depId)
        if (!dependency) return false
        return dependency.status === "done" || scheduledIds.has(depId)
      })

      if (!requirementsSatisfied) continue

      scheduledIds.add(task.id)
      madeProgress = true
    }
  }

  return pendingTasks.filter(task => scheduledIds.has(task.id))
}

export function buildExecutionGraph(tasks: Task[], parallelLimit: number): ExecutionGraph {
  const executableTasks = getExecutionGraphTasks(tasks)
  const batches = resolveBatches(executableTasks, parallelLimit)

  const nodes = executableTasks.map(t => ({
    id: t.id,
    name: t.name,
    status: t.status,
    requirements: t.requirements,
  }))

  const edges: { from: string; to: string }[] = []
  for (const t of executableTasks) {
    for (const dep of t.requirements) {
      if (executableTasks.some(et => et.id === dep)) {
        edges.push({ from: dep, to: t.id })
      }
    }
  }

  return {
    batches: batches.map((batch, idx) => ({
      idx,
      taskIds: batch.map(t => t.id),
      taskNames: batch.map(t => t.name),
    })),
    nodes,
    edges,
    totalTasks: executableTasks.length,
    parallelLimit,
  }
}
