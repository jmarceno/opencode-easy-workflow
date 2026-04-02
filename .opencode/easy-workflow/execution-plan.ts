import type { Task } from "./types"

export function getExecutableTasks(tasks: Task[]): Task[] {
  const seen = new Set<string>()
  const executable: Task[] = []

  for (const task of tasks) {
    const isBacklogTask = task.status === "backlog" && task.executionPhase !== "plan_complete_waiting_approval"
    const isApprovedPlanTask = task.executionPhase === "implementation_pending"
    if (!isBacklogTask && !isApprovedPlanTask) continue
    if (seen.has(task.id)) continue
    seen.add(task.id)
    executable.push(task)
  }

  return executable
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
  nodes: { id: string; name: string; status: string; requirements: string[] }[]
  edges: { from: string; to: string }[]
  totalTasks: number
  parallelLimit: number
}

export function buildExecutionGraph(tasks: Task[], parallelLimit: number): ExecutionGraph {
  const executableTasks = getExecutableTasks(tasks)
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