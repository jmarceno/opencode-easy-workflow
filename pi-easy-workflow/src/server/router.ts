import type { RequestContext, RouteHandler, RouteParams } from "./types.ts"

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

interface RouteEntry {
  method: Method
  pattern: string
  regex: RegExp
  paramNames: string[]
  handler: RouteHandler
}

function compilePattern(pattern: string): { regex: RegExp; paramNames: string[] } {
  const segments = pattern.split("/").filter(Boolean)
  const paramNames: string[] = []
  const regexParts = segments.map((segment) => {
    if (segment.startsWith(":")) {
      paramNames.push(segment.slice(1))
      return "([^/]+)"
    }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  })
  return {
    regex: new RegExp(`^/${regexParts.join("/")}${pattern.endsWith("/") && pattern !== "/" ? "/" : ""}$`),
    paramNames,
  }
}

export class Router {
  private readonly routes: RouteEntry[] = []

  register(method: Method, pattern: string, handler: RouteHandler): void {
    const compiled = compilePattern(pattern)
    this.routes.push({ method, pattern, regex: compiled.regex, paramNames: compiled.paramNames, handler })
  }

  get(pattern: string, handler: RouteHandler): void {
    this.register("GET", pattern, handler)
  }

  post(pattern: string, handler: RouteHandler): void {
    this.register("POST", pattern, handler)
  }

  put(pattern: string, handler: RouteHandler): void {
    this.register("PUT", pattern, handler)
  }

  patch(pattern: string, handler: RouteHandler): void {
    this.register("PATCH", pattern, handler)
  }

  delete(pattern: string, handler: RouteHandler): void {
    this.register("DELETE", pattern, handler)
  }

  async dispatch(method: string, path: string, baseContext: Omit<RequestContext, "params">): Promise<Response | null> {
    for (const route of this.routes) {
      if (route.method !== method) continue
      const match = path.match(route.regex)
      if (!match) continue

      const params: RouteParams = {}
      for (let i = 0; i < route.paramNames.length; i++) {
        params[route.paramNames[i]] = decodeURIComponent(match[i + 1] ?? "")
      }

      return await route.handler({ ...baseContext, params })
    }

    return null
  }
}
