/**
 * A small local HTTP proxy in front of a SOCKS proxy.
 *
 * Bun's `fetch` can use an HTTP proxy but not a SOCKS one. This bridge listens
 * on loopback, accepts CONNECT tunnels, and opens them through a SOCKS4 or
 * SOCKS5 upstream. Bun's own fetch then goes through the bridge, so the TLS
 * handshake OpenCode Free checks is still Bun's -- which is the whole reason a
 * relay or a proxy works where a Cloudflare Worker does not.
 *
 * Adapted from Polygate's backend/socks-bridge.ts (MIT, (c) 2026 B3hnamR).
 * The public surface is smaller because this plugin only dials proxies the user
 * added; there is no pool scanner.
 */
import net from "node:net"
import dns from "node:dns/promises"
import { UPSTREAM_HOST } from "../lib/types.ts"

export interface SocksUpstream {
  readonly version: 4 | 5
  readonly host: string
  readonly port: number
  readonly username?: string
  readonly password?: string
}

/** A started local bridge: the proxy address and the secret it demands. */
export interface SocksBridge {
  /** The local HTTP proxy address. The secret is not in it. */
  readonly url: string
  /** The secret a client has to present to use the bridge. */
  readonly secret: string
}

const HEADER_LIMIT = 16 * 1024
const IDLE_MS = 10 * 60_000
const MAX_BRIDGES = 64

/**
 * How long a client may take to send its request head.
 *
 * The secret is only checked once the head is complete, so a client that
 * opens a connection and says nothing would hold a socket open for free.
 */
const HEAD_TIMEOUT_MS = 10_000
/**
 * The length a SOCKS credential may have.
 *
 * The protocol carries the username and the password in a single byte, so a
 * longer one cannot be written: the length would wrap and the handshake
 * would break in a way that looks like a broken server.
 */
const CREDENTIAL_LIMIT = 255

interface Bridge {
  readonly key: string
  readonly server: net.Server
  /** The `Proxy-Authorization` value a client has to send. */
  readonly auth: string
  active: number
  last: number
}

const bridges = new Map<string, Promise<SocksBridge>>()
const meta = new Map<string, Bridge>()

function dropBridge(bridge: Bridge): void {
  bridge.server.close()
  bridges.delete(bridge.key)
  meta.delete(bridge.key)
}

function sweep(): void {
  const now = Date.now()
  for (const bridge of [...meta.values()]) {
    if (bridge.active === 0 && now - bridge.last >= IDLE_MS) dropBridge(bridge)
  }
}

/**
 * Whether the local proxy may dial this host.
 *
 * The bridge listens on loopback without authentication, so any local process
 * could otherwise use the user's SOCKS credentials as an open proxy. The plugin
 * itself only ever asks for the upstream host and its subdomains, so that is
 * all it may reach -- the same rule bridge.ts and hooks.ts apply. The dot in
 * the suffix test is what rejects lookalikes such as "notopencode.ai" or
 * "opencode.ai.evil.com".
 */
function isAllowedTarget(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "")
  return name === UPSTREAM_HOST || name.endsWith(`.${UPSTREAM_HOST}`)
}

const keyOf = (up: SocksUpstream): string =>
  `${up.version}|${up.username ?? ""}:${up.password ?? ""}@${up.host}:${up.port}`

const REPLIES = [
  "succeeded",
  "general failure",
  "connection not allowed",
  "network unreachable",
  "host unreachable",
  "connection refused",
  "TTL expired",
  "command not supported",
  "address type not supported",
]

/** The 16 bytes of an IPv6 address, in any of the usual written forms. */
function ipv6Bytes(address: string): Buffer {
  const [head, tail = ""] = address.split("::")
  const left = head ? head.split(":") : []
  const right = tail ? tail.split(":") : []
  const groups = address.includes("::")
    ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right]
    : left
  const out = Buffer.alloc(16)
  groups.forEach((group, index) => out.writeUInt16BE(parseInt(group || "0", 16), index * 2))
  return out
}

/**
 * Whether the credentials can be written into the SOCKS handshake.
 *
 * The username and the password travel in a single byte each, so a longer
 * one cannot be sent at all: the length would wrap and the server would
 * read a different credential. Refusing here says so plainly, instead of
 * failing later as an unexplained refusal from the proxy.
 */
function credentialsFit(up: SocksUpstream): boolean {
  const user = Buffer.byteLength(up.username ?? "", "utf8")
  const password = Buffer.byteLength(up.password ?? "", "utf8")
  return user <= CREDENTIAL_LIMIT && password <= CREDENTIAL_LIMIT
}

/** Open a SOCKS5 tunnel. The host is sent as a name, so the proxy resolves it. */
export function socks5Connect(
  up: SocksUpstream,
  host: string,
  port: number,
  timeoutMs = 15_000,
): Promise<net.Socket> {
  if (!credentialsFit(up)) {
    return Promise.reject(
      new Error(`The SOCKS credentials for ${up.host}:${up.port} are longer than ${CREDENTIAL_LIMIT} bytes.`),
    )
  }
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: up.host, port: up.port })
    socket.setNoDelay(true)
    let state: "method" | "auth" | "connect" = "method"
    let buffer = Buffer.alloc(0)
    let done = false
    const fail = (error: Error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      reject(error)
    }
    const timer = setTimeout(
      () => fail(new Error(`SOCKS5 ${up.host}:${up.port} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
    const sendConnect = () => {
      state = "connect"
      const kind = net.isIP(host)
      const address =
        kind === 4
          ? Buffer.concat([Buffer.from([0x01]), Buffer.from(host.split(".").map(Number))])
          : kind === 6
            ? Buffer.concat([Buffer.from([0x04]), ipv6Bytes(host)])
            : Buffer.concat([Buffer.from([0x03, Buffer.byteLength(host)]), Buffer.from(host)])
      socket.write(
        Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00]),
          address,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        ]),
      )
    }
    socket.once("connect", () =>
      socket.write(
        up.username
          ? Buffer.from([0x05, 0x02, 0x00, 0x02])
          : Buffer.from([0x05, 0x01, 0x00]),
      ),
    )
    socket.on("data", (chunk: Buffer) => {
      if (done) return
      buffer = Buffer.concat([buffer, chunk])
      if (state === "method") {
        if (buffer.length < 2) return
        if (buffer[0] !== 0x05) return fail(new Error("Not a SOCKS5 server"))
        const method = buffer[1]
        buffer = buffer.subarray(2)
        if (method === 0x00) return sendConnect()
        if (method === 0x02 && up.username) {
          const user = Buffer.from(up.username)
          const password = Buffer.from(up.password ?? "")
          state = "auth"
          return void socket.write(
            Buffer.concat([
              Buffer.from([0x01, user.length]),
              user,
              Buffer.from([password.length]),
              password,
            ]),
          )
        }
        return fail(new Error(`SOCKS5 server refused every authentication method (${method})`))
      }
      if (state === "auth") {
        if (buffer.length < 2) return
        if (buffer[0] !== 0x01) return fail(new Error("Not a SOCKS5 server"))
        if (buffer[1] !== 0x00) return fail(new Error("SOCKS5 username/password rejected"))
        buffer = buffer.subarray(2)
        return sendConnect()
      }
      if (buffer[0] !== 0x05) return fail(new Error("Not a SOCKS5 server"))
      if (buffer.length < 4) return
      if (buffer[1] !== 0x00) {
        return fail(
          new Error(
            `SOCKS5 connect to ${host}:${port} failed: ${REPLIES[buffer[1] ?? 0] ?? `code ${buffer[1]}`}`,
          ),
        )
      }
      const atyp = buffer[3]
      const length = atyp === 0x01 ? 10 : atyp === 0x04 ? 22 : atyp === 0x03 ? (buffer.length > 4 ? 7 + (buffer[4] ?? 0) : 99) : 0
      if (!length) return fail(new Error("SOCKS5 reply has an unknown address type"))
      if (buffer.length < length) return
      done = true
      clearTimeout(timer)
      socket.removeAllListeners("data")
      socket.removeAllListeners("error")
      // link() attaches the real handlers a moment later. Until it does, the
      // socket must keep an error listener: an RST in this window would emit
      // `error` on a listener-less socket, and an unhandled `error` throws
      // and takes the process down.
      socket.on("error", () => {})
      const rest = buffer.subarray(length)
      if (rest.length > 0) socket.unshift(rest)
      resolve(socket)
    })
    socket.once("error", fail)
    socket.once("close", () => fail(new Error("SOCKS5 connection closed during handshake")))
  })
}

/** Open a SOCKS4 tunnel. SOCKS4 carries IPv4 only, so the name is resolved here. */
export async function socks4Connect(
  up: SocksUpstream,
  host: string,
  port: number,
  timeoutMs = 15_000,
): Promise<net.Socket> {
  if (!credentialsFit(up)) {
    throw new Error(`The SOCKS credentials for ${up.host}:${up.port} are longer than ${CREDENTIAL_LIMIT} bytes.`)
  }
  const ip = net.isIPv4(host) ? host : (await dns.lookup(host, { family: 4 })).address
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: up.host, port: up.port })
    socket.setNoDelay(true)
    let buffer = Buffer.alloc(0)
    let done = false
    const fail = (error: Error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      reject(error)
    }
    const timer = setTimeout(
      () => fail(new Error(`SOCKS4 ${up.host}:${up.port} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
    socket.once("connect", () =>
      socket.write(
        Buffer.concat([
          Buffer.from([0x04, 0x01, (port >> 8) & 0xff, port & 0xff]),
          Buffer.from(ip.split(".").map(Number)),
          Buffer.from(up.username ?? ""),
          Buffer.from([0x00]),
        ]),
      ),
    )
    socket.on("data", (chunk: Buffer) => {
      if (done) return
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length < 8) return
      if (buffer[0] !== 0x00) {
        return fail(new Error("Not a SOCKS4 server"))
      }
      if (buffer[1] !== 0x5a) {
        return fail(new Error(`SOCKS4 connect to ${host}:${port} was refused (code ${buffer[1]})`))
      }
      done = true
      clearTimeout(timer)
      socket.removeAllListeners("data")
      socket.removeAllListeners("error")
      // Same window as in socks5Connect: keep the socket from emitting an
      // unhandled `error` before link() takes over.
      socket.on("error", () => {})
      const rest = buffer.subarray(8)
      if (rest.length > 0) socket.unshift(rest)
      resolve(socket)
    })
    socket.once("error", fail)
    socket.once("close", () => fail(new Error("SOCKS4 connection closed during handshake")))
  })
}

function connect(up: SocksUpstream, host: string, port: number): Promise<net.Socket> {
  return up.version === 4 ? socks4Connect(up, host, port) : socks5Connect(up, host, port)
}

function link(a: net.Socket, b: net.Socket): void {
  a.on("error", () => b.destroy())
  b.on("error", () => a.destroy())
  a.on("close", () => b.destroy())
  b.on("close", () => a.destroy())
  a.pipe(b)
  b.pipe(a)
  a.resume()
}

/**
 * The `Proxy-Authorization` value in a request head, if it carries one.
 *
 * The header is read from the head the client sent, before anything is
 * forwarded: the bridge checks it before it opens a tunnel.
 */
function proxyAuthorization(lines: readonly string[]): string | undefined {
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":")
    if (colon <= 0) continue
    if (line.slice(0, colon).trim().toLowerCase() !== "proxy-authorization") continue
    return line.slice(colon + 1).trim()
  }
  return undefined
}

/** Handle one HTTP-proxy connection: CONNECT or an absolute-form request. */
function handle(client: net.Socket, up: SocksUpstream, auth: string): void {
  client.setNoDelay(true)
  let head = Buffer.alloc(0)
  const refuse = (status: string) => {
    try {
      client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    } catch {
      client.destroy()
    }
  }
  // A client that opens a connection and never finishes its request would
  // hold the socket, and the bridge with it, for as long as it likes: the
  // secret is only checked once the head is complete. The head has a
  // deadline of its own.
  const headTimer = setTimeout(() => {
    client.off("data", onData)
    client.destroy()
  }, HEAD_TIMEOUT_MS)
  headTimer.unref?.()
  const onData = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk])
    const end = head.indexOf("\r\n\r\n")
    if (end < 0) {
      if (head.length > HEADER_LIMIT) {
        client.off("data", onData)
        clearTimeout(headTimer)
        refuse("431 Request Header Fields Too Large")
      }
      return
    }
    client.off("data", onData)
    clearTimeout(headTimer)
    client.pause()
    const text = head.subarray(0, end).toString("latin1")
    const rest = head.subarray(end + 4)
    const lines = text.split("\r\n")
    const [method, target, version] = (lines[0] ?? "").split(" ")
    if (!method || !target || !version) {
      refuse("400 Bad Request")
      return
    }
    // The bridge is a local proxy that carries the user's SOCKS credentials,
    // so only a client that knows the bridge's own secret may use it. Without
    // this, any process on this machine could spend the user's proxy.
    if (proxyAuthorization(lines) !== auth) {
      refuse("407 Proxy Authentication Required")
      return
    }
    const dial = async () => {
      if (method === "CONNECT") {
        const colon = target.lastIndexOf(":")
        if (colon <= 0) {
          refuse("400 Bad Request")
          return
        }
        const host = target.slice(0, colon).replace(/^\[|\]$/g, "")
        const port = Number(target.slice(colon + 1))
        if (!host || !(port > 0)) {
          refuse("400 Bad Request")
          return
        }
        if (!isAllowedTarget(host)) {
          refuse("403 Forbidden")
          return
        }
        const upstream = await connect(up, host, port)
        if (client.destroyed) {
          upstream.destroy()
          return
        }
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        if (rest.length > 0) upstream.write(rest)
        link(client, upstream)
        return
      }
      const url = new URL(target)
      const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80)
      if (url.protocol !== "http:") {
        refuse("400 Bad Request")
        return
      }
      if (!isAllowedTarget(url.hostname)) {
        refuse("403 Forbidden")
        return
      }
      const upstream = await connect(up, url.hostname.replace(/^\[|\]$/g, ""), port)
      if (client.destroyed) {
        upstream.destroy()
        return
      }
      // A header line is forwarded as it was read, so a value with a bare
      // line feed in it would smuggle a header of its own into the upstream
      // request. A line with a control character in it is refused.
      const headers = lines
        .slice(1)
        .filter((line) => !/^(proxy-|connection:|keep-alive:)/i.test(line))
      if (headers.some((line) => /[\r\n\0]/.test(line))) {
        refuse("400 Bad Request")
        return
      }
      upstream.write(
        Buffer.concat([
          Buffer.from(
            `${method} ${url.pathname}${url.search} ${version}\r\n${[...headers, "Connection: close"].join("\r\n")}\r\n\r\n`,
            "latin1",
          ),
          rest,
        ]),
      )
      link(client, upstream)
    }
    void dial().catch(() => refuse("502 Bad Gateway"))
  }
  client.on("data", onData)
  client.on("error", () => client.destroy())
}

/** The local HTTP proxy for a SOCKS upstream, started on first use. */
export function socksBridge(up: SocksUpstream): Promise<SocksBridge> {
  // Reap idle bridges on use, not only when the map is full, so a long session
  // does not keep one listening server per proxy it ever used.
  sweep()
  const key = keyOf(up)
  const existing = bridges.get(key)
  if (existing) return existing
  // Every bridge gets its own secret: the bridge is a local proxy that
  // spends the user's SOCKS credentials, so a client has to prove it may.
  const secret = crypto.randomUUID().replace(/-/g, "")
  const auth = `Basic ${Buffer.from(`${secret}:`).toString("base64")}`
  const started = new Promise<SocksBridge>((resolve, reject) => {
    if (meta.size >= MAX_BRIDGES) {
      const idle = [...meta.values()]
        .filter((bridge) => bridge.active === 0)
        .sort((a, b) => a.last - b.last)[0]
      if (idle) dropBridge(idle)
      // Sweeping one idle bridge was the last chance: a cap that can still be
      // exceeded is not a cap, so a still-full map refuses instead.
      if (meta.size >= MAX_BRIDGES) {
        reject(new Error("Too many SOCKS bridges"))
        return
      }
    }
    const entry = { key, server: undefined as unknown as net.Server, auth, active: 0, last: Date.now() }
    const server = net.createServer((client) => {
      entry.active++
      client.once("close", () => {
        entry.active--
        entry.last = Date.now()
      })
      handle(client, up, auth)
    })
    entry.server = server
    meta.set(key, entry)
    server.once("error", (error) => {
      // A bind error must not leave a dead entry behind: it would count
      // against the cap forever, with nothing listening at all.
      meta.delete(key)
      reject(error)
    })
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, secret }),
    )
  })
  bridges.set(key, started)
  started.catch(() => bridges.delete(key))
  return started
}

/** Stop every local bridge. Called when the plugin unloads. */
export function closeSocksBridges(): void {
  for (const bridge of meta.values()) bridge.server.close()
  bridges.clear()
  meta.clear()
}

/** Read a socks4:// or socks5:// URL into an upstream, or nothing. */
export function parseSocksUrl(raw: string): SocksUpstream | undefined {
  try {
    const url = new URL(raw)
    if (!/^socks(4a?|5h?):$/.test(url.protocol)) return undefined
    const upstream: SocksUpstream = {
      version: url.protocol.startsWith("socks4") ? 4 : 5,
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: Number(url.port) || 1080,
      ...(url.username.length > 0 ? { username: decodeURIComponent(url.username) } : {}),
      ...(url.password.length > 0 ? { password: decodeURIComponent(url.password) } : {}),
    }
    // A credential the protocol cannot carry is refused here, where the user
    // is told why, rather than in the handshake, where it would look like a
    // proxy that refuses every authentication method.
    if (!credentialsFit(upstream)) return undefined
    return upstream
  } catch {
    return undefined
  }
}
