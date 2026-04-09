import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "fs"
import { basename, dirname, join, resolve } from "path"
import { fileURLToPath } from "url"

export interface SyncSkillsOptions {
  sourceDir?: string
  destinationDir?: string
  clean?: boolean
}

export interface SkillDescriptor {
  name: string
  directory: string
  skillFile: string
}

export interface SyncSkillsResult {
  sourceDir: string
  destinationDir: string
  skillCount: number
  copiedFiles: number
}

export function getProjectRoot(fromFileUrl: string = import.meta.url): string {
  const currentFile = fileURLToPath(fromFileUrl)
  return resolve(dirname(currentFile), "..")
}

export function discoverSkills(sourceDir: string): SkillDescriptor[] {
  if (!existsSync(sourceDir)) {
    throw new Error(`Skills source directory does not exist: ${sourceDir}`)
  }

  const entries = readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))

  const skills: SkillDescriptor[] = []
  for (const name of entries) {
    const directory = join(sourceDir, name)
    const skillFile = join(directory, "SKILL.md")
    if (!existsSync(skillFile)) {
      continue
    }
    skills.push({ name, directory, skillFile })
  }

  if (skills.length === 0) {
    throw new Error(`No skills found in source directory: ${sourceDir}`)
  }

  return skills
}

function countFilesRecursively(directory: string): number {
  if (!existsSync(directory)) return 0
  let count = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      count += countFilesRecursively(fullPath)
    } else if (entry.isFile()) {
      count += 1
    }
  }
  return count
}

function ensureDestinationDirectory(destinationDir: string, clean: boolean): void {
  if (clean && existsSync(destinationDir)) {
    rmSync(destinationDir, { recursive: true, force: true })
  }
  mkdirSync(destinationDir, { recursive: true })
}

function copySkillDirectory(skillDirectory: string, destinationDir: string): number {
  const destinationSkillDir = join(destinationDir, basename(skillDirectory))
  cpSync(skillDirectory, destinationSkillDir, {
    recursive: true,
    preserveTimestamps: true,
    force: true,
  })
  return countFilesRecursively(destinationSkillDir)
}

export function syncSkills(options: SyncSkillsOptions = {}): SyncSkillsResult {
  const projectRoot = getProjectRoot()
  const sourceDir = resolve(options.sourceDir ?? join(projectRoot, "skills"))
  const destinationDir = resolve(options.destinationDir ?? join(projectRoot, ".pi", "skills"))
  const clean = options.clean ?? false

  const sourceStats = statSync(sourceDir, { throwIfNoEntry: false })
  if (!sourceStats || !sourceStats.isDirectory()) {
    throw new Error(`Skills source directory does not exist: ${sourceDir}`)
  }

  const skills = discoverSkills(sourceDir)
  ensureDestinationDirectory(destinationDir, clean)

  let copiedFiles = 0
  for (const skill of skills) {
    copiedFiles += copySkillDirectory(skill.directory, destinationDir)
  }

  return {
    sourceDir,
    destinationDir,
    skillCount: skills.length,
    copiedFiles,
  }
}

function parseCliArgs(args: string[]): SyncSkillsOptions {
  return {
    clean: args.includes("--clean"),
  }
}

if (import.meta.main) {
  try {
    const result = syncSkills(parseCliArgs(process.argv.slice(2)))
    console.log(`Synced ${result.skillCount} skills to .pi/skills/ (${result.copiedFiles} files copied)`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Failed to sync skills: ${message}`)
    process.exitCode = 1
  }
}
