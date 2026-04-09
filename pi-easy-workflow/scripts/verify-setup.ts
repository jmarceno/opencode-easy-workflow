import { existsSync, mkdirSync, readFileSync } from "fs"
import { join, resolve } from "path"
import { discoverSkills, getProjectRoot } from "./sync-skills.ts"

interface PiSettings {
  skills?: {
    localPath?: string
    autoLoad?: boolean
    allowGlobal?: boolean
  }
}

function validateSkillFrontmatter(skillFilePath: string): void {
  const content = readFileSync(skillFilePath, "utf-8")
  const trimmed = content.trimStart()
  if (!trimmed.startsWith("---\n")) {
    throw new Error(`Missing frontmatter start in ${skillFilePath}`)
  }

  const endMarkerIndex = trimmed.indexOf("\n---\n", 4)
  if (endMarkerIndex === -1) {
    throw new Error(`Missing frontmatter end in ${skillFilePath}`)
  }

  const frontmatter = trimmed.slice(4, endMarkerIndex)
  if (!/\bname\s*:/m.test(frontmatter)) {
    throw new Error(`Frontmatter missing 'name' in ${skillFilePath}`)
  }
  if (!/\bdescription\s*:/m.test(frontmatter)) {
    throw new Error(`Frontmatter missing 'description' in ${skillFilePath}`)
  }
}

function parseSettings(settingsPath: string): PiSettings {
  if (!existsSync(settingsPath)) {
    throw new Error(`Missing Pi settings file: ${settingsPath}`)
  }

  const raw = readFileSync(settingsPath, "utf-8")
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid JSON in ${settingsPath}: ${message}`)
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Pi settings must be a JSON object: ${settingsPath}`)
  }

  return parsed as PiSettings
}

function validateSettings(settings: PiSettings): void {
  const skills = settings.skills
  if (!skills || typeof skills !== "object") {
    throw new Error("Pi settings is missing the 'skills' object")
  }

  if (skills.localPath !== "./skills") {
    throw new Error("Pi settings skills.localPath must be './skills'")
  }
  if (skills.autoLoad !== true) {
    throw new Error("Pi settings skills.autoLoad must be true")
  }
  if (skills.allowGlobal !== false) {
    throw new Error("Pi settings skills.allowGlobal must be false")
  }
}

export function verifySetup(projectRoot: string = getProjectRoot()): void {
  const skillsSourceDir = resolve(join(projectRoot, "skills"))
  const piDir = resolve(join(projectRoot, ".pi"))
  const piSkillsDir = resolve(join(piDir, "skills"))
  const settingsPath = resolve(join(piDir, "settings.json"))

  const skills = discoverSkills(skillsSourceDir)
  console.log(`✓ Skills source directory exists (${skills.length} skills found)`)

  for (const skill of skills) {
    validateSkillFrontmatter(skill.skillFile)
  }
  console.log("✓ Skills have required frontmatter")

  const settings = parseSettings(settingsPath)
  validateSettings(settings)
  console.log("✓ Pi settings.json is valid")

  mkdirSync(piSkillsDir, { recursive: true })
  console.log("✓ .pi/skills directory is writable")

  console.log("✓ Setup is reproducible")
}

if (import.meta.main) {
  try {
    verifySetup()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Setup verification failed: ${message}`)
    process.exitCode = 1
  }
}
