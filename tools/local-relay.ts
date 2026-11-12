/**
 * Runs the relay locally, the way it runs on Vercel.
 *
 * Used to check the plugin end to end without deploying anything: the relay
 * answers on a local port and the plugin talks to it exactly as it would talk
 * to the deployed one.
 *
 *   bun tools/local-relay.ts [port]
 */
import { createServer } from "node:http"
import relay from "../relay/relay.js"

const port = Number(process.argv[2] ?? 8787)
const token = process.env.RELAY_TOKEN ?? "local-test-token"

process.env.RELAY_TOKEN = token

const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on("data", (chunk: Buffer) => chunks.push(chunk))
  req.on("end", async () => {
    const body = Buffer.concat(chunks)
    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(key, value)
    }
    const request = new Request(`http://localhost:${port}${req.url}`, {
      method: req.method,
      headers,
      body: body.length > 0 ? body : undefined,
      duplex: "half",
    } as RequestInit)
    const response = await relay.fetch(request)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    if (response.body) {
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(Buffer.from(value))
      }
    }
    res.end()
  })
})

server.listen(port, () => {
  console.log(`relay listening on http://localhost:${port} (token: ${token})`)
})