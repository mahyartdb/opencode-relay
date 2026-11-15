/**
 * The loopback bridge that lets a proxy carry an OpenCode request.
 *
 * The plugin's only routing seam is `http.request`: it can replace a Request,
 * but it cannot call `fetch` with Bun's `proxy` option. This bridge is the
 * small process that can. It listens on 127.0.0.1, accepts a request that names
 * a proxy and a target, and answers with the upstream response streamed back.
 *
 * It is deliberately narrow:
 * - loopback only, with a random per-process secret;
 * - only https://opencode.ai (and its subdomains) may be reached;
 * - a proxy that is missing, paused or unknown is refused;
 * - redirects are never followed.
 */
import { UPSTREAM_HOST } from "../lib/types.ts"
import { parseSocksUrl, socksBridge } from "./socks-bridge.ts"

/** What the bridge needs to find the proxy a request names. */
export interface BridgeDeps {
  /** The proxy URL for an id, or undefined when it is gone or paused. */
  readonly proxyUrl: (id: string) => string | undefined
}

/** Headers that describe this hop or the bridge itself. */
const STRIP = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "upgrade",
  "x-bridge-exit",
  "x-bridge-target",
  "x-bridge-key",
])

/** Bun's fetch options, including the ones its TypeScript types may not know yet. */
type ProxiedInit = RequestInit & {
  proxy?: string | { url: string; headers?: Record<string, string> }
  respectNoProxy?: boolean
  duplex?: "half"
}

/**
 * Send one request through one proxy.
 *
 * HTTP and HTTPS proxies are handed to Bun directly. SOCKS proxies need the
 * local adapter in socks-bridge.ts, because Bun can only speak HTTP to a proxy.
 * `respectNoProxy` is false on purpose: the user chose this exit, and an
 * unrelated NO_PROXY setting must not silently send the request direct.
 */
export async function fetchThroughProxy(
  proxyUrl: string,
  target: string,
  init: RequestInit,
): Promise<Response> {
  const parsed = new URL(proxyUrl)
  let endpoint = proxyUrl
  let proxy: ProxiedInit["proxy"] = proxyUrl
  if (parsed.protocol === "socks4:" || parsed.protocol === "socks4a:" || parsed.protocol === "socks5:" || parsed.protocol === "socks5h:") {
    const upstream = parseSocksUrl(proxyUrl)
    if (!upstream) throw new Error("The SOCKS proxy address could not be read.")
    const bridge = await socksBridge(upstream)
    endpoint = bridge.url
    // The local bridge spends the user's SOCKS credentials, so it asks for a
    // secret of its own. The secret is sent as a proxy header rather than in
    // the address, so it does not end up in an error message.
    proxy = {
      url: bridge.url,
      headers: { "Proxy-Authorization": `Basic ${Buffer.from(`${bridge.secret}:`).toString("base64")}` },
    }
  }
  return fetch(target, {
    ...init,
    proxy,
    respectNoProxy: false,
    redirect: "manual",
  } as ProxiedInit)
}

/** A loopback HTTP server that turns a request header into a proxied fetch. */
export class ProxyBridge {
  private server: Bun.Server<unknown> | undefined
  private readonly secret = crypto.randomUUID().replace(/-/g, "")
  private base = ""

  constructor(private readonly deps: BridgeDeps) {}

  /** Start listening. Safe to call twice. */
  start(): void {
    if (this.server) return
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      // A long inference may take minutes between bytes; the bridge must not
      // turn that into a dead request before OpenCode does.
      idleTimeout: 255,
      fetch: (request) => this.handle(request),
    })
    this.base = `http://127.0.0.1:${this.server.port}`
  }

  /** The origin the request hook points at. */
  get origin(): string {
    return this.base
  }

  /** The secret a request must carry to be accepted. */
  get key(): string {
    return this.secret
  }

  /** False when the server never started, so proxies cannot be used. */
  get ready(): boolean {
    return this.base.length > 0
  }

  /** Stop listening. */
  stop(): void {
    this.server?.stop(true)
    this.server = undefined
    this.base = ""
  }

  private async handle(request: Request): Promise<Response> {
    if (!this.ready || !sameSecret(request.headers.get("x-bridge-key"), this.secret)) {
      return bridgeError(401, { error: "Unauthorized bridge request" })
    }
    const id = request.headers.get("x-bridge-exit") ?? ""
    const target = request.headers.get("x-bridge-target") ?? ""
    if (id.length === 0 || target.length === 0) {
      return bridgeError(400, { error: "Missing bridge headers" })
    }
    let url: URL
    try {
      url = new URL(target)
    } catch {
      return bridgeError(400, { error: "Bad target" })
    }
    const host = url.hostname.toLowerCase()
    if (url.protocol !== "https:" || !(host === UPSTREAM_HOST || host.endsWith(`.${UPSTREAM_HOST}`))) {
      return bridgeError(403, { error: "Target host not allowed" })
    }
    const proxy = this.deps.proxyUrl(id)
    if (proxy === undefined) {
      return bridgeError(409, { error: "The proxy is not available" })
    }
    const headers = new Headers()
    request.headers.forEach((value, name) => {
      if (STRIP.has(name.toLowerCase())) return
      headers.set(name, value)
    })
    const method = request.method
    const init: ProxiedInit = {
      method,
      headers,
      signal: request.signal,
      redirect: "manual",
    }
    if (method !== "GET" && method !== "HEAD" && request.body !== null) {
      init.body = request.body
      init.duplex = "half"
    }
    try {
      const response = await fetchThroughProxy(proxy, url.toString(), init)
      const out = new Headers(response.headers)
      for (const name of ["content-length", "transfer-encoding", "connection", "content-encoding"]) {
        out.delete(name)
      }
      out.set("x-bridge-exit", id)
      return new Response(response.body, { status: response.status, headers: out })
    } catch (error) {
      // The detail belongs in the plugin's note, not in a response that could
      // be read by anything else on loopback.
      console.error("[relay] proxy request failed", error)
      return bridgeError(502, { error: "The proxy could not carry the request" })
    }
  }
}

function sameSecret(given: string | null, required: string): boolean {
  if (given === null || given.length !== required.length) return false
  let diff = 0
  for (let index = 0; index < required.length; index++) {
    diff |= given.charCodeAt(index) ^ required.charCodeAt(index)
  }
  return diff === 0
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/**
 * An answer the bridge itself made.
 *
 * The bridge answers a few requests itself: a wrong secret, a target it does
 * not allow, a proxy that is gone. Those answers say nothing about the exit
 * behind them, so they are marked: the hook does not book them as the exit's
 * health, and does not blame the exit for them.
 */
function bridgeError(status: number, body: unknown): Response {
  const response = json(status, body)
  response.headers.set("x-bridge-error", "1")
  return response
}
