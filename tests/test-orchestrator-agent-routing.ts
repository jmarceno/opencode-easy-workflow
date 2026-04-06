#!/usr/bin/env bun
/**
 * Unit tests for orchestrator agent routing based on skipPermissionAsking flag.
 * Tests that autonomous agents are selected only when the flag is enabled,
 * and that the standard interactive agents are preserved when disabled.
 */

import { resolvePlanningAgent, resolveExecutionAgent, mapThinkingLevelToAgent } from "../src/orchestrator"

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

console.log("=== Orchestrator Agent Routing Unit Tests ===\n")

console.log("-- Standard agents (skipPermissionAsking = false) --\n")

test("mapThinkingLevelToAgent: default returns null", () => {
  assertEq(mapThinkingLevelToAgent("default"), null)
})

test("mapThinkingLevelToAgent: low returns build-fast", () => {
  assertEq(mapThinkingLevelToAgent("low"), "build-fast")
})

test("mapThinkingLevelToAgent: medium returns build", () => {
  assertEq(mapThinkingLevelToAgent("medium"), "build")
})

test("mapThinkingLevelToAgent: high returns deep-thinker", () => {
  assertEq(mapThinkingLevelToAgent("high"), "deep-thinker")
})

test("resolvePlanningAgent: false returns plan", () => {
  assertEq(resolvePlanningAgent(false), "plan")
})

test("resolvePlanningAgent: true returns workflow-plan", () => {
  assertEq(resolvePlanningAgent(true), "workflow-plan")
})

test("resolveExecutionAgent: false + default returns null", () => {
  assertEq(resolveExecutionAgent(false, "default"), null)
})

test("resolveExecutionAgent: false + low returns build-fast", () => {
  assertEq(resolveExecutionAgent(false, "low"), "build-fast")
})

test("resolveExecutionAgent: false + medium returns build", () => {
  assertEq(resolveExecutionAgent(false, "medium"), "build")
})

test("resolveExecutionAgent: false + high returns deep-thinker", () => {
  assertEq(resolveExecutionAgent(false, "high"), "deep-thinker")
})

console.log("\n-- Autonomous agents (skipPermissionAsking = true) --\n")

test("resolveExecutionAgent: true + default returns workflow-build", () => {
  assertEq(resolveExecutionAgent(true, "default"), "workflow-build")
})

test("resolveExecutionAgent: true + low returns workflow-build-fast", () => {
  assertEq(resolveExecutionAgent(true, "low"), "workflow-build-fast")
})

test("resolveExecutionAgent: true + medium returns workflow-build", () => {
  assertEq(resolveExecutionAgent(true, "medium"), "workflow-build")
})

test("resolveExecutionAgent: true + high returns workflow-deep-thinker", () => {
  assertEq(resolveExecutionAgent(true, "high"), "workflow-deep-thinker")
})

console.log("\n-- Backward compatibility: skipPermissionAsking=false preserves existing behavior --\n")

test("skipPermissionAsking=false is backward compatible for planning", () => {
  assertEq(resolvePlanningAgent(false), "plan")
})

test("skipPermissionAsking=false is backward compatible for execution: default", () => {
  assertEq(resolveExecutionAgent(false, "default"), null)
})

test("skipPermissionAsking=false is backward compatible for execution: low", () => {
  assertEq(resolveExecutionAgent(false, "low"), "build-fast")
})

test("skipPermissionAsking=false is backward compatible for execution: medium", () => {
  assertEq(resolveExecutionAgent(false, "medium"), "build")
})

test("skipPermissionAsking=false is backward compatible for execution: high", () => {
  assertEq(resolveExecutionAgent(false, "high"), "deep-thinker")
})

console.log("\n-- Autonomous mode routing is correct --\n")

test("skipPermissionAsking=true routes planning to workflow-plan", () => {
  assertEq(resolvePlanningAgent(true), "workflow-plan")
})

test("skipPermissionAsking=true routes low thinking to workflow-build-fast", () => {
  assertEq(resolveExecutionAgent(true, "low"), "workflow-build-fast")
})

test("skipPermissionAsking=true routes default thinking to workflow-build", () => {
  assertEq(resolveExecutionAgent(true, "default"), "workflow-build")
})

test("skipPermissionAsking=true routes medium thinking to workflow-build", () => {
  assertEq(resolveExecutionAgent(true, "medium"), "workflow-build")
})

test("skipPermissionAsking=true routes high thinking to workflow-deep-thinker", () => {
  assertEq(resolveExecutionAgent(true, "high"), "workflow-deep-thinker")
})

console.log("\nAll agent routing tests passed")
