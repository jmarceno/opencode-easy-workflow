#!/usr/bin/env bun
import { createInterface } from "readline"
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on("line", (line) => {
  // Echo back with response format
  try {
    const request = JSON.parse(line)
    const id = request?.id
    if (id) {
      console.log(JSON.stringify({ 
        id, 
        type: "response", 
        command: request.type || "unknown", 
        success: true,
        data: { echo: request }
      }))
    }
  } catch {}
})
