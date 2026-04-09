type NormalizedModel = {
  id: string
  label: string
  value: string
}

type NormalizedProvider = {
  id: string
  name: string
  models: NormalizedModel[]
}

export type NormalizedModelCatalog = {
  providers: NormalizedProvider[]
  defaults: Record<string, string>
  warning?: string
}

let cache: { expiresAt: number; value: NormalizedModelCatalog } | null = null

function parsePiListModelsOutput(stdout: string): NormalizedModelCatalog {
  const lines = stdout.split("\n").filter((line) => line.trim())
  const providersById = new Map<string, NormalizedProvider>()

  for (const line of lines) {
    // Skip header lines and separator lines
    if (line.startsWith("provider") || line.startsWith("-")) continue
    if (!line.includes("  ")) continue

    // Parse the table format: provider      model                   context  max-out  thinking  images
    const parts = line.trim().split(/\s{2,}/)
    if (parts.length < 2) continue

    const providerId = parts[0].trim()
    const modelId = parts[1].trim()

    if (!providerId || !modelId) continue

    const provider = providersById.get(providerId) ?? { id: providerId, name: providerId, models: [] }
    if (!provider.models.some((m) => m.id === modelId)) {
      provider.models.push({
        id: modelId,
        label: modelId,
        value: `${providerId}/${modelId}`,
      })
    }
    providersById.set(providerId, provider)
  }

  const providers = [...providersById.values()].map((provider) => ({
    ...provider,
    models: provider.models.sort((a, b) => a.label.localeCompare(b.label)),
  })).sort((a, b) => a.name.localeCompare(b.name))

  return { providers, defaults: {} }
}

async function runPiModelCommand(timeoutMs = 5000): Promise<NormalizedModelCatalog> {
  // Use shell to ensure proper PATH and environment
  // Note: pi --list-models outputs to stderr, not stdout!
  const command = Bun.spawn({
    cmd: ["bash", "-c", "PI_OFFLINE=1 pi --offline --list-models"],
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })

  const timeoutPromise = Bun.sleep(timeoutMs).then(() => {
    try {
      command.kill()
    } catch {
      // no-op
    }
    throw new Error(`Pi model discovery timed out after ${timeoutMs}ms`)
  })

  const outputPromise = Promise.all([
    new Response(command.stdout).text(),
    new Response(command.stderr).text(),
    command.exited,
  ])

  const [stdoutText, stderrText, exitCode] = await Promise.race([outputPromise, timeoutPromise]) as [string, string, number]

  // pi --list-models outputs to stderr, not stdout!
  // Combine both stdout and stderr to capture the model list
  const combinedOutput = stderrText + stdoutText

  if (exitCode !== 0 && exitCode !== null) {
    // Sometimes exit code is null if process is killed, but we may still have output
    if (!combinedOutput.includes("provider")) {
      throw new Error(stderrText.trim() || `pi --list-models failed with exit code ${exitCode}`)
    }
  }

  // Filter out extension initialization messages
  const cleanOutput = combinedOutput
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim()
      if (!trimmed) return false
      // Skip extension initialization messages
      if (trimmed.startsWith("Easy Workflow")) return false
      if (trimmed.startsWith("Easy Workflow extension")) return false
      if (trimmed.startsWith("Easy Workflow kanban")) return false
      if (trimmed.includes("extension initializing")) return false
      if (trimmed.startsWith("port:")) return false
      if (trimmed.startsWith("url:")) return false
      if (trimmed.startsWith("ownerDirectory:")) return false
      if (trimmed.startsWith("pid:")) return false
      if (trimmed.startsWith("New session")) return false
      if (trimmed.startsWith("sessionFile:")) return false
      if (trimmed.startsWith("cwd:")) return false
      return true
    })
    .join("\n")

  return parsePiListModelsOutput(cleanOutput)
}

export async function discoverPiModels(options: { forceRefresh?: boolean; ttlMs?: number; maxRetries?: number; commandTimeoutMs?: number } = {}): Promise<NormalizedModelCatalog> {
  const ttlMs = options.ttlMs ?? 60_000
  const maxRetries = Math.max(1, options.maxRetries ?? 2)
  const commandTimeoutMs = Math.max(500, options.commandTimeoutMs ?? 5000)

  if (!options.forceRefresh && cache && cache.expiresAt > Date.now()) {
    return cache.value
  }

  let lastError: unknown = null
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const value = await runPiModelCommand(commandTimeoutMs)
      if (value.providers.length > 0) {
        cache = { value, expiresAt: Date.now() + ttlMs }
        return value
      }
      throw new Error("No models found in pi CLI output")
    } catch (error) {
      lastError = error
      if (attempt < maxRetries - 1) await Bun.sleep(500 * Math.pow(2, attempt))
    }
  }

  // Return empty catalog with warning
  const warning = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error")
  const emptyCatalog: NormalizedModelCatalog = {
    providers: [],
    defaults: {},
    warning: `Model catalog temporarily unavailable: ${warning}`,
  }
  cache = { value: emptyCatalog, expiresAt: Date.now() + 10_000 }
  return emptyCatalog
}
