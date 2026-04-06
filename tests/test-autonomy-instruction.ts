#!/usr/bin/env bun
/**
 * Unit tests for AUTONOMY_INSTRUCTION presence in prompt construction.
 * Verifies that the autonomy instruction is present in all execution-related prompts.
 */

import { readFileSync } from "fs"
import { join } from "path"
import { AUTONOMY_INSTRUCTION, PLANNING_ONLY_INSTRUCTION } from "../.opencode/easy-workflow/orchestrator"

const ORCHESTRATOR_PATH = join(process.cwd(), ".opencode", "easy-workflow", "orchestrator.ts")

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

function testAutonomyInstructionIsExported() {
  console.log("Testing AUTONOMY_INSTRUCTION is exported...")
  assert(typeof AUTONOMY_INSTRUCTION === "string", "AUTONOMY_INSTRUCTION should be a string")
  assert(AUTONOMY_INSTRUCTION.length > 0, "AUTONOMY_INSTRUCTION should not be empty")
  assert(AUTONOMY_INSTRUCTION.includes("EXECUTE END-TO-END"), "AUTONOMY_INSTRUCTION should contain 'EXECUTE END-TO-END'")
  assert(AUTONOMY_INSTRUCTION.includes("missing credentials"), "AUTONOMY_INSTRUCTION should mention missing credentials")
  assert(AUTONOMY_INSTRUCTION.includes("missing required external input"), "AUTONOMY_INSTRUCTION should mention missing required external input")
  assert(AUTONOMY_INSTRUCTION.includes("irreversible product decision"), "AUTONOMY_INSTRUCTION should mention irreversible product decision")
  console.log("  ✓ AUTONOMY_INSTRUCTION is properly defined")
}

function testPlanningOnlyInstructionIsExported() {
  console.log("Testing PLANNING_ONLY_INSTRUCTION is exported...")
  assert(typeof PLANNING_ONLY_INSTRUCTION === "string", "PLANNING_ONLY_INSTRUCTION should be a string")
  assert(PLANNING_ONLY_INSTRUCTION.length > 0, "PLANNING_ONLY_INSTRUCTION should not be empty")
  assert(PLANNING_ONLY_INSTRUCTION.includes("PREPARE PLAN ONLY"), "PLANNING_ONLY_INSTRUCTION should contain 'PREPARE PLAN ONLY'")
  assert(PLANNING_ONLY_INSTRUCTION.includes("Output only the plan"), "PLANNING_ONLY_INSTRUCTION should mention 'Output only the plan'")
  console.log("  ✓ PLANNING_ONLY_INSTRUCTION is properly defined")
}

function testAutonomyInstructionInDirectExecutionPrompt() {
  console.log("Testing AUTONOMY_INSTRUCTION in direct execution prompt...")
  const content = readFileSync(ORCHESTRATOR_PATH, "utf-8")

  const directExecutionPattern = /text:\s*`\$\{AUTONOMY_INSTRUCTION\}\\n\\n\$\{task\.prompt\}`/
  assert(directExecutionPattern.test(content), "Direct execution prompt should prepend AUTONOMY_INSTRUCTION to task.prompt")

  console.log("  ✓ Direct execution prompt includes AUTONOMY_INSTRUCTION")
}

function testAutonomyInstructionInPlanModePlanningPrompt() {
  console.log("Testing PLANNING_ONLY_INSTRUCTION in plan-mode planning prompt...")
  const content = readFileSync(ORCHESTRATOR_PATH, "utf-8")

  const planModePlanningPattern = /agent:\s*resolvePlanningAgent\(task\.skipPermissionAsking\),\s*model:\s*planModelParsed,\s*parts:\s*\[{\s*type:\s*"text",\s*text:\s*`\$\{PLANNING_ONLY_INSTRUCTION\}/
  assert(planModePlanningPattern.test(content), "Plan-mode planning prompt should include PLANNING_ONLY_INSTRUCTION")

  console.log("  ✓ Plan-mode planning prompt includes PLANNING_ONLY_INSTRUCTION")
}

function testAutonomyInstructionInPlanModeImplementationPrompt() {
  console.log("Testing AUTONOMY_INSTRUCTION in plan-mode implementation prompt...")
  const content = readFileSync(ORCHESTRATOR_PATH, "utf-8")

  const implementationPattern = /AUTONOMY_INSTRUCTION[\s\S]*?The user has approved the plan below/
  assert(implementationPattern.test(content), "Plan-mode implementation prompt should include AUTONOMY_INSTRUCTION before 'The user has approved'")

  console.log("  ✓ Plan-mode implementation prompt includes AUTONOMY_INSTRUCTION")
}

function testAutonomyInstructionInPlanRevisionPrompt() {
  console.log("Testing PLANNING_ONLY_INSTRUCTION in plan revision prompt...")
  const content = readFileSync(ORCHESTRATOR_PATH, "utf-8")

  const revisionPattern = /revisionPrompt[\s\S]*?PLANNING_ONLY_INSTRUCTION[\s\S]*?The user has reviewed your plan/
  assert(revisionPattern.test(content), "Plan revision prompt should include PLANNING_ONLY_INSTRUCTION before 'The user has reviewed'")

  console.log("  ✓ Plan revision prompt includes PLANNING_ONLY_INSTRUCTION")
}

function testAutonomyInstructionInBuildWorkerPrompt() {
  console.log("Testing AUTONOMY_INSTRUCTION in buildWorkerPrompt...")
  const content = readFileSync(ORCHESTRATOR_PATH, "utf-8")

  const workerPattern = /buildWorkerPrompt\([\s\S]*?let prompt[\s\S]*?\$\{AUTONOMY_INSTRUCTION\}/
  assert(workerPattern.test(content), "buildWorkerPrompt should start with AUTONOMY_INSTRUCTION")

  console.log("  ✓ buildWorkerPrompt includes AUTONOMY_INSTRUCTION")
}

function testAutonomyInstructionInBuildFinalApplierPrompt() {
  console.log("Testing AUTONOMY_INSTRUCTION in buildFinalApplierPrompt...")
  const content = readFileSync(ORCHESTRATOR_PATH, "utf-8")

  const finalApplierPattern = /buildFinalApplierPrompt[\s\S]*?let prompt[\s\S]*?\$\{AUTONOMY_INSTRUCTION\}/
  assert(finalApplierPattern.test(content), "buildFinalApplierPrompt should include AUTONOMY_INSTRUCTION at the start")

  console.log("  ✓ buildFinalApplierPrompt includes AUTONOMY_INSTRUCTION")
}

function testAutonomyInstructionNotInReviewPrompt() {
  console.log("Testing AUTONOMY_INSTRUCTION is NOT in review prompt (by design)...")
  const content = readFileSync(ORCHESTRATOR_PATH, "utf-8")

  const reviewPromptPattern = /Review the current repository state against the task/
  const match = content.match(reviewPromptPattern)
  if (match) {
    const reviewSectionIndex = content.indexOf(match[0])
    const beforeReview = content.substring(0, reviewSectionIndex)
    const afterReview = content.substring(reviewSectionIndex)
    const autonomyInReviewSection = afterReview.indexOf(AUTONOMY_INSTRUCTION)
    const autonomyBeforeReview = beforeReview.lastIndexOf(AUTONOMY_INSTRUCTION)

    assert(autonomyInReviewSection === -1 || autonomyBeforeReview > reviewSectionIndex,
      "AUTONOMY_INSTRUCTION should not appear in review prompt section")
  }
  console.log("  ✓ Review prompt does not include AUTONOMY_INSTRUCTION (by design)")
}

function runAllTests() {
  console.log("=== AUTONOMY_INSTRUCTION Prompt Inclusion Tests ===\n")

  try {
    testAutonomyInstructionIsExported()
    testPlanningOnlyInstructionIsExported()
    testAutonomyInstructionInDirectExecutionPrompt()
    testAutonomyInstructionInPlanModePlanningPrompt()
    testAutonomyInstructionInPlanModeImplementationPrompt()
    testAutonomyInstructionInPlanRevisionPrompt()
    testAutonomyInstructionInBuildWorkerPrompt()
    testAutonomyInstructionInBuildFinalApplierPrompt()
    testAutonomyInstructionNotInReviewPrompt()

    console.log("\n✓ All tests passed!")
    process.exit(0)
  } catch (error) {
    console.error("\n✗ Test failed:", error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

runAllTests()