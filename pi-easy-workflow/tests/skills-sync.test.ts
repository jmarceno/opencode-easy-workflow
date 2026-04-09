import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { syncSkills } from "../scripts/sync-skills.ts"

const createdDirs: string[] = []

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-skills-sync-test-"))
  createdDirs.push(root)
  return root
}

function writeSkill(root: string, name: string, body: string): string {
  const skillDir = join(root, "skills", name)
  mkdirSync(skillDir, { recursive: true })
  const skillFile = join(skillDir, "SKILL.md")
  writeFileSync(skillFile, body, "utf-8")
  return skillFile
}

afterEach(() => {
  for (const dir of createdDirs.splice(0, createdDirs.length)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("syncSkills", () => {
  it("creates destination and copies all skills", () => {
    const root = createTempRoot()
    const skillBodyA = "---\nname: a\ndescription: A\n---\n\nA\n"
    const skillBodyB = "---\nname: b\ndescription: B\n---\n\nB\n"
    writeSkill(root, "skill-a", skillBodyA)
    writeSkill(root, "skill-b", skillBodyB)

    const result = syncSkills({
      sourceDir: join(root, "skills"),
      destinationDir: join(root, ".pi", "skills"),
    })

    expect(result.skillCount).toBe(2)
    expect(existsSync(join(root, ".pi", "skills", "skill-a", "SKILL.md"))).toBe(true)
    expect(existsSync(join(root, ".pi", "skills", "skill-b", "SKILL.md"))).toBe(true)
    expect(readFileSync(join(root, ".pi", "skills", "skill-a", "SKILL.md"), "utf-8")).toBe(skillBodyA)
  })

  it("clean mode removes stale skill directories before copy", () => {
    const root = createTempRoot()
    writeSkill(root, "skill-a", "---\nname: a\ndescription: A\n---\n")

    const destination = join(root, ".pi", "skills")
    mkdirSync(join(destination, "stale-skill"), { recursive: true })
    writeFileSync(join(destination, "stale-skill", "SKILL.md"), "stale", "utf-8")

    syncSkills({
      sourceDir: join(root, "skills"),
      destinationDir: destination,
      clean: true,
    })

    expect(existsSync(join(destination, "stale-skill"))).toBe(false)
    expect(existsSync(join(destination, "skill-a", "SKILL.md"))).toBe(true)
  })

  it("throws when source directory is missing", () => {
    const root = createTempRoot()
    expect(() =>
      syncSkills({
        sourceDir: join(root, "does-not-exist"),
        destinationDir: join(root, ".pi", "skills"),
      }),
    ).toThrow("Skills source directory does not exist")
  })
})
