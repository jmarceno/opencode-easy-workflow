import { createPiServer } from "./server.ts"

export async function main(): Promise<void> {
  const requestedPort = process.env.PI_EASY_WORKFLOW_PORT ? Number(process.env.PI_EASY_WORKFLOW_PORT) : undefined
  const dbPath = process.env.PI_EASY_WORKFLOW_DB_PATH

  const { db, server } = createPiServer({
    ...(Number.isFinite(requestedPort) ? { port: requestedPort } : {}),
    ...(dbPath ? { dbPath } : {}),
  })

  const port = await server.start(Number.isFinite(requestedPort) ? (requestedPort as number) : undefined)
  console.log(`[pi-easy-workflow] server started on http://0.0.0.0:${port}`)

  const shutdown = () => {
    try {
      server.stop()
    } finally {
      db.close()
    }
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

void main()
