function scanFirstBalancedJsonObject(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const source = codeBlockMatch?.[1]?.trim() || trimmed

  const start = source.indexOf("{")
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escapeNext = false
  for (let idx = start; idx < source.length; idx++) {
    const ch = source[idx]
    if (escapeNext) {
      escapeNext = false
      continue
    }
    if (ch === "\\") {
      escapeNext = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === "{") depth++
    if (ch === "}") {
      depth--
      if (depth === 0) {
        return source.slice(start, idx + 1)
      }
    }
  }

  return null
}

export function parseStrictJsonObject(text: string, errorContext: string): Record<string, unknown> {
  const candidate = scanFirstBalancedJsonObject(text)
  if (!candidate) {
    throw new Error(`${errorContext}: missing JSON object in model response`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    throw new Error(`${errorContext}: invalid JSON in model response`)
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${errorContext}: expected a JSON object response`)
  }
  return parsed as Record<string, unknown>
}
