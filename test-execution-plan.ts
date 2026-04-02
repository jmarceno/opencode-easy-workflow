#!/usr/bin/env bun
/**
 * Unit tests for execution-plan.ts
 */

import { getExecutableTasks, resolveBatches, buildExecutionGraph } from "./.opencode/easy-workflow/execution-plan"
import type { Task } from "./.opencode/easy-workflow/types"

function makeTask(overrides: Partial<Task> & { id: string; name: string }): Task {
  return {
    id: "",
    name: "",
    prompt: "",
    status: "backlog",
    executionPhase: "pending",
    planModel: "default",
    executionModel: "default",
    thinkingLevel: "medium",
    planmode: false,
    review: false,
    autoCommit: false,
    requirements: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as Task
}

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`✓ ${name}`)
  } catch (err) {
    console.error(`✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }
}

function assertEq<T>(actual: T, expected: T, msg?: string) {
  if (actual !== expected) {
    throw new Error(msg ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

console.log("=== Execution Plan Unit Tests ===\n")

test("getExecutableTasks returns backlog tasks", () => {
  const tasks = [
    makeTask({ id: "1", name: "Task 1", status: "backlog", executionPhase: "pending" }),
    makeTask({ id: "2", name: "Task 2", status: "done", executionPhase: "done" }),
    makeTask({ id: "3", name: "Task 3", status: "executing", executionPhase: "pending" }),
  ]
  const result = getExecutableTasks(tasks)
  assertEq(result.length, 1)
  assertEq(result[0].id, "1")
})

test("getExecutableTasks excludes plan_complete_waiting_approval tasks", () => {
  const tasks = [
    makeTask({ id: "1", name: "Task 1", status: "backlog", executionPhase: "plan_complete_waiting_approval" }),
  ]
  const result = getExecutableTasks(tasks)
  assertEq(result.length, 0)
})

test("getExecutableTasks includes implementation_pending tasks", () => {
  const tasks = [
    makeTask({ id: "1", name: "Task 1", status: "backlog", executionPhase: "implementation_pending" }),
  ]
  const result = getExecutableTasks(tasks)
  assertEq(result.length, 1)
})

test("resolveBatches handles no dependencies", () => {
  const tasks = [
    makeTask({ id: "1", name: "Task 1" }),
    makeTask({ id: "2", name: "Task 2" }),
    makeTask({ id: "3", name: "Task 3" }),
  ]
  const batches = resolveBatches(tasks, 2)
  assertEq(batches.length, 2) // 3 tasks with parallel limit 2 = 2 batches
})

test("resolveBatches respects dependencies", () => {
  const tasks = [
    makeTask({ id: "1", name: "Task 1" }),
    makeTask({ id: "2", name: "Task 2", requirements: ["1"] }),
    makeTask({ id: "3", name: "Task 3", requirements: ["1"] }),
    makeTask({ id: "4", name: "Task 4", requirements: ["2"] }),
  ]
  const batches = resolveBatches(tasks, 2)
  // Batch 1: Task 1
  // Batch 2: Task 2, Task 3 (parallel, both depend on 1)
  // Batch 3: Task 4 (depends on 2)
  assertEq(batches.length, 3)
  assertEq(batches[0].length, 1)
  assertEq(batches[0][0].id, "1")
  assertEq(batches[1].length, 2)
  assertEq(batches[2].length, 1)
  assertEq(batches[2][0].id, "4")
})

test("resolveBatches throws on circular dependency", () => {
  const tasks = [
    makeTask({ id: "1", name: "Task 1", requirements: ["2"] }),
    makeTask({ id: "2", name: "Task 2", requirements: ["1"] }),
  ]
  let threw = false
  try {
    resolveBatches(tasks, 2)
  } catch (err) {
    threw = true
    if (!err instanceof Error || !err.message.includes("Circular dependency")) {
      throw new Error("Wrong error type thrown")
    }
  }
  if (!threw) throw new Error("Expected circular dependency error")
})

test("buildExecutionGraph returns correct structure", () => {
  const tasks = [
    makeTask({ id: "1", name: "Task 1" }),
    makeTask({ id: "2", name: "Task 2", requirements: ["1"] }),
  ]
  const graph = buildExecutionGraph(tasks, 2)
  assertEq(graph.totalTasks, 2)
  assertEq(graph.parallelLimit, 2)
  assertEq(graph.batches.length, 2)
  assertEq(graph.nodes.length, 2)
  assertEq(graph.edges.length, 1)
  assertEq(graph.edges[0].from, "1")
  assertEq(graph.edges[0].to, "2")
})

console.log("\n=== All Tests Passed ===")