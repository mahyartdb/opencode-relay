/**
 * Runs the relay the way Vercel runs it.
 *
 * The relay is a plain function that answers a Request. Vercel gives it a
 * request and takes the answer; this helper does the same over a local port,
 * so the plugin can be exercised against the real relay without deploying
 * anything.
 */
import { createServer, type Server } from "node:http"

export interface RelayServer {
  /** The server, so it can be closed. */
  readonly server: Server
  /** The address the relay answers on, for example http://localhost:41234. */
  readonly url: string
  /** The port the relay was given. */
  readonly port: number
}

/**
 * Starts the relay on a port.
 *
 * A port of 0 asks the operating system for a free one, so two runs never
 * fight over the same port.
 */
export async function startRelay(port = 0): Promise<RelayServer> {
  process.env.RELAY_TOKEN = process.env.RELAY_TOKEN ?? "local-test-token"

  const { default: relay } = await import("../relay/relay.js")

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
      const answer = await relay.fetch(request)
      const out: Record<string, string> = {}
      answer.headers.forEach((value, key) => {
        out[key] = value
      })
      res.writeHead(answer.status, out)
      if (answer.body) {
        for await (const chunk of answer.body as unknown as AsyncIterable<Uint8Array>) {
          res.write(Buffer.from(chunk))
        }
      }
      res.end()
    })
  })

  await new Promise<void>((resolve) => server.listen(port, resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("the relay did not start")
  return { server, port: address.port, url: `http://localhost:${address.port}` }
}

/**
 * Stands in for the address lookup the relay does.
 *
 * The relay asks a third party what address it is seen from. Pointing that
 * lookup at a local server keeps the tests from depending on that service.
 */
export async function startTraceStub(address = "203.0.113.7"): Promise<Server> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end(`fl=00000000\nip=${address}\nts=0\nvisit_scheme=https\n`)
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  return server
}

/** The address of a running trace stub. */
export function traceUrl(server: Server): string {
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("the trace stub did not start")
  return `http://localhost:${address.port}/cdn-cgi/trace`
}