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

function normalizeRawPiCatalog(raw: unknown): NormalizedModelCatalog {
  const defaults: Record<string, string> = {}

  const asArray = (value: unknown): any[] => (Array.isArray(value) ? value : [])
  const providersById = new Map<string, NormalizedProvider>()

  const providerEntries = asArray((raw as any)?.providers)
  for (const providerEntry of providerEntries) {
    const providerId = String(providerEntry?.id ?? providerEntry?.name ?? "").trim()
    if (!providerId) continue
    const providerName = String(providerEntry?.name ?? providerId)

    const models: NormalizedModel[] = []
    const modelsObject = providerEntry?.models
    if (modelsObject && typeof modelsObject === "object" && !Array.isArray(modelsObject)) {
      for (const [modelIdRaw, modelValueRaw] of Object.entries(modelsObject as Record<string, unknown>)) {
        const modelId = String(modelIdRaw)
        const modelLabel = typeof modelValueRaw === "object" && modelValueRaw !== null && "label" in modelValueRaw
          ? String((modelValueRaw as any).label)
          : modelId
        models.push({ id: modelId, label: modelLabel, value: `${providerId}/${modelId}` })
      }
    } else {
      for (const modelEntry of asArray(modelsObject)) {
        const modelId = String(modelEntry?.id ?? modelEntry?.name ?? "").trim()
        if (!modelId) continue
        models.push({
          id: modelId,
          label: String(modelEntry?.label ?? modelEntry?.name ?? modelId),
          value: `${providerId}/${modelId}`,
        })
      }
    }

    providersById.set(providerId, { id: providerId, name: providerName, models })
  }

  const topModels = asArray((raw as any)?.models)
  for (const modelEntry of topModels) {
    const fullId = String(modelEntry?.id ?? modelEntry?.name ?? "").trim()
    if (!fullId) continue
    const sep = fullId.indexOf("/")
    if (sep <= 0 || sep === fullId.length - 1) continue
    const providerId = fullId.slice(0, sep)
    const modelId = fullId.slice(sep + 1)
    const modelLabel = String(modelEntry?.label ?? modelId)

    const provider = providersById.get(providerId) ?? { id: providerId, name: providerId, models: [] }
    if (!provider.models.some((m) => m.id === modelId)) {
      provider.models.push({ id: modelId, label: modelLabel, value: `${providerId}/${modelId}` })
    }
    providersById.set(providerId, provider)
  }

  const defaultMap = (raw as any)?.defaultModel ?? (raw as any)?.defaults ?? (raw as any)?.defaultModels
  if (defaultMap && typeof defaultMap === "object") {
    for (const [providerId, modelId] of Object.entries(defaultMap as Record<string, unknown>)) {
      if (typeof providerId !== "string" || typeof modelId !== "string") continue
      defaults[providerId] = `${providerId}/${modelId}`
    }
  }

  const providers = [...providersById.values()].map((provider) => ({
    ...provider,
    models: provider.models.sort((a, b) => a.label.localeCompare(b.label)),
  })).sort((a, b) => a.name.localeCompare(b.name))

  return { providers, defaults }
}

async function runPiModelCommand(timeoutMs = 1500): Promise<unknown> {
  const command = Bun.spawn({
    cmd: ["pi", "models", "list", "--json"],
    stdout: "pipe",
    stderr: "pipe",
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
  if (exitCode !== 0) {
    throw new Error(stderrText.trim() || `pi models list --json failed with exit code ${exitCode}`)
  }

  const raw = stdoutText.trim()
  if (!raw) return { providers: [] }

  try {
    return JSON.parse(raw)
  } catch {
    const firstJsonLine = raw.split("\n").find((line) => line.trim().startsWith("{"))
    if (!firstJsonLine) throw new Error("Pi models output is not valid JSON")
    return JSON.parse(firstJsonLine)
  }
}

export async function discoverPiModels(options: { forceRefresh?: boolean; ttlMs?: number; maxRetries?: number; commandTimeoutMs?: number } = {}): Promise<NormalizedModelCatalog> {
  const ttlMs = options.ttlMs ?? 60_000
  const maxRetries = Math.max(1, options.maxRetries ?? 3)
  const commandTimeoutMs = Math.max(300, options.commandTimeoutMs ?? 1500)
  if (!options.forceRefresh && cache && cache.expiresAt > Date.now()) {
    return cache.value
  }

  let lastError: unknown = null
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const raw = await runPiModelCommand(commandTimeoutMs)
      const value = normalizeRawPiCatalog(raw)
      cache = { value, expiresAt: Date.now() + ttlMs }
      return value
    } catch (error) {
      lastError = error
      if (attempt < maxRetries - 1) await Bun.sleep(500 * Math.pow(2, attempt))
    }
  }

  const warning = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error")
  const fallback: NormalizedModelCatalog = {
    providers: [],
    defaults: {},
    warning: `Model catalog temporarily unavailable: ${warning}`,
  }
  cache = { value: fallback, expiresAt: Date.now() + 10_000 }
  return fallback
}
