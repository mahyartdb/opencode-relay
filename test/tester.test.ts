import { afterEach, describe, expect, test } from "bun:test"
import net from "node:net"
import tls from "node:tls"
import { readFileSync } from "node:fs"
import type { RelayRecord } from "../src/lib/types.ts"
import { RelayState } from "../src/server/state.ts"
import { Tester } from "../src/server/tester.ts"

/**
 * What a check is allowed to conclude from an answer.
 *
 * Every test talks to a local server that answers exactly like the thing under
 * test needs it to. A 200 from an auth portal, a redirect, an empty answer and
 * a real chat completion all look different to the judge, and only the last one
 * may become routable.
 */

const running: Array<{ stop: (closeActiveConnections?: boolean) => void }> = []

afterEach(() => {
  for (const server of running.splice(0)) server.stop(true)
})

function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler })
  running.push(server)
  return { url: `http://127.0.0.1:${server.port}`, server }
}

function memoryStorage() {
  const store = new Map<string, unknown>()
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => {
      store.set(key, value)
    },
    remove: async (key: string) => {
      store.delete(key)
    },
    scan: async () => ({ entries: [] }),
  }
}

/**
 * The certificate a tunnel stub presents for the upstream host, and the raw
 * net-server helpers the SOCKS stubs need. The pair is generated once per run
 * into this file's directory, so no fixture file is needed.
 */
let tlsStubPartsPromise:
  | {
      KEY: string
      CERT: string
      stubServer: (onData: (socket: net.Socket) => void) => Promise<{
        server: net.Server
        port: number
      }>
      closeServer: (server: net.Server) => Promise<void>
    }
  | undefined

async function tlsStubParts() {
  if (tlsStubPartsPromise) return tlsStubPartsPromise
  // Bun can mint a key pair itself, but not an X.509 certificate, so the pair
  // is signed with whatever openssl the machine has. Git for Windows bundles
  // one even when PATH does not.
  const candidates = [
    "openssl",
    "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
    "C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe",
  ]
  let pem = ""
  for (const candidate of candidates) {
    let out = ""
    try {
      const proc = Bun.spawnSync([
        candidate,
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-keyout",
        "-",
        "-out",
        "-",
        "-days",
        "30",
        "-nodes",
        "-subj",
        "/CN=opencode.ai",
        "-addext",
        "subjectAltName=DNS:opencode.ai",
      ])
      out = new TextDecoder().decode(proc.stdout)
    } catch {
      continue
    }
    if (out.includes("-----BEGIN CERTIFICATE-----")) {
      pem = out
      break
    }
  }
  if (!pem) throw new Error("no openssl could mint the stub certificate")
  const split = pem.indexOf("-----BEGIN CERTIFICATE-----")
  const parts = {
    KEY: pem.slice(0, split),
    CERT: pem.slice(split),
    stubServer: netStubServer,
    closeServer: netCloseServer,
  }
  tlsStubPartsPromise = parts
  return parts
}

function netStubServer(onData: (socket: net.Socket) => void) {
  return new Promise<{ server: net.Server; port: number }>((resolve) => {
    const server = net.createServer(onData)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") throw new Error("the stub has no port")
      resolve({ server, port: address.port })
    })
  })
}

async function netCloseServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

/** A tester pointed at a local server that stands in for the relay. */
async function setup(handler: (request: Request) => Response | Promise<Response>) {
  const served = serve(handler)
  const state = new RelayState(memoryStorage() as never)
  await state.load()
  const exit: RelayRecord = {
    kind: "relay",
    id: "relay-1",
    name: "local",
    project: "",
    region: "",
    url: served.url,
    access: "test-access",
    accountId: "",
    enabled: true,
    status: "untested",
    createdAt: Date.now(),
  }
  await state.addRelay(exit)
  const tester = new Tester({ state, announce: async () => {} })
  return { state, tester, id: exit.id }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

/** A model list for the deep test to pick a model from, and a chat answer. */
async function modelServer(answer: () => Response | Promise<Response>) {
  return setup(async (request) => {
    const path = request.headers.get("x-relay-path") ?? ""
    if (path.includes("/models")) return json({ data: [{ id: "iceman-free" }] })
    return answer()
  })
}

describe("the api check", () => {
  test("a 200 answer is reachable, not ready", async () => {
    const made = await setup(() => new Response("{}", { status: 200 }))

    const result = await made.tester.test(made.id, "api")

    expect(result.ok).toBe(true)
    expect(result.status).toBe("reachable")
    expect(result.code).toBe(200)
  })

  test("it never carries the user's session token", async () => {
    // The api check runs on every exit on a timer, so a credential in it
    // would be handed to whatever address an imported configuration named.
    let seen: Headers | undefined
    const made = await setup((request) => {
      seen = request.headers
      return new Response("{}", { status: 200 })
    })
    made.state.noteSample({
      modelID: "iceman-free",
      path: "/inference/openai/v1/chat/completions",
      headers: {
        authorization: "Bearer session-token",
        cookie: "session=cookie-value",
        "x-custom": "kept",
      },
    })

    await made.tester.test(made.id, "api")

    expect(seen?.get("authorization")).toBeNull()
    expect(seen?.get("cookie")).toBeNull()
    // Only the headers that cannot be a credential travel: a list of names
    // to exclude would break the day OpenCode sends a new one.
    expect(seen?.get("x-custom")).toBeNull()
  })

  test("the deep check does carry the session token, or it cannot work", async () => {
    let seen: Headers | undefined
    const made = await setup((request) => {
      seen = request.headers
      const path = request.headers.get("x-relay-path") ?? ""
      if (path.includes("/models")) return json({ data: [{ id: "iceman-free" }] })
      return json({ choices: [{ message: { content: "ok" } }] })
    })
    made.state.noteSample({
      modelID: "iceman-free",
      path: "/inference/openai/v1/chat/completions",
      headers: { authorization: "Bearer session-token" },
    })

    await made.tester.test(made.id, "deep")

    expect(seen?.get("authorization")).toBe("Bearer session-token")
  })

  test("a 204 answer is a failure, not a routable exit", async () => {
    const made = await setup(() => new Response(null, { status: 204 }))

    const result = await made.tester.test(made.id, "api")

    expect(result.ok).toBe(false)
    expect(result.status).toBe("bad")
    expect(result.code).toBe(204)
    expect(made.state.exit(made.id)?.status).toBe("bad")
  })

  test("a redirect is a failure, not a routable exit", async () => {
    const made = await setup(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://login.example.com/" },
        }),
    )

    const result = await made.tester.test(made.id, "api")

    expect(result.ok).toBe(false)
    expect(result.status).toBe("bad")
    expect(result.code).toBe(302)
    expect(made.state.exit(made.id)?.status).toBe("bad")
  })

  test("401 and 403 from OpenCode block the exit", async () => {
    for (const status of [401, 403]) {
      // The relay's own headers say the answer came from the upstream through
      // it, so the refusal is OpenCode's.
      const made = await setup(() =>
        new Response("{}", { status, headers: { "x-relay-instance": "i1" } }),
      )
      const result = await made.tester.test(made.id, "api")

      expect(result.status).toBe("blocked")
      expect(result.code).toBe(status)
      expect(made.state.exit(made.id)?.status).toBe("blocked")
    }
  })

  test("401 and 403 from the relay itself fail the exit", async () => {
    // The relay answered without reaching the upstream, so it refused the
    // plugin: the access token is wrong. Blaming OpenCode would send the
    // user after the wrong party.
    for (const status of [401, 403]) {
      const made = await setup(() => new Response("{}", { status }))
      const result = await made.tester.test(made.id, "api")

      expect(result.status).toBe("bad")
      expect(result.note).toContain("access token")
      expect(made.state.exit(made.id)?.status).toBe("bad")
    }
  })

  test("a 500 answer fails the exit", async () => {
    const made = await setup(() => new Response("{}", { status: 500 }))

    const result = await made.tester.test(made.id, "api")

    expect(result.status).toBe("bad")
    expect(result.code).toBe(500)
    expect(made.state.exit(made.id)?.status).toBe("bad")
  })

  test("a free-limit 429 exhausts the exit", async () => {
    const until = Date.now() + 60_000
    const made = await setup(
      () =>
        new Response('{"error":{"message":"Free usage limit reached"}}', {
          status: 429,
          headers: { "retry-after": String(Math.ceil((until - Date.now()) / 1000)) },
        }),
    )

    const result = await made.tester.test(made.id, "api")

    expect(result.status).toBe("exhausted")
    expect(made.state.exit(made.id)?.status).toBe("exhausted")
    expect(made.state.exit(made.id)?.exhaustedUntil ?? 0).toBeGreaterThan(Date.now())
    expect(made.state.exhaustedExits()).toContain(made.id)
  })

  test("a plain 429 limits the exit and arms the cooldown", async () => {
    const made = await setup(
      () => new Response('{"error":{"message":"rate limit exceeded"}}', { status: 429 }),
    )

    const result = await made.tester.test(made.id, "api")

    expect(result.ok).toBe(false)
    expect(result.status).toBe("limited")
    expect(made.state.exit(made.id)?.status).toBe("limited")
    expect(made.state.coolingExits()).toContain(made.id)
    expect(made.state.pickExit({ advance: false }).exit).toBeUndefined()
  })

  test("a bare 409 fails the exit without retiring it as used up", async () => {
    const made = await setup(() => new Response("{}", { status: 409 }))

    const result = await made.tester.test(made.id, "api")

    expect(result.ok).toBe(false)
    expect(result.status).toBe("bad")
    expect(result.code).toBe(409)
    expect(made.state.exit(made.id)?.status).toBe("bad")
    expect(made.state.exit(made.id)?.exhaustedUntil).toBeUndefined()
    expect(made.state.exhaustedExits()).toEqual([])
  })

  test("a rotate 409 exhausts the exit", async () => {
    const made = await setup(
      () =>
        new Response("{}", {
          status: 409,
          headers: { "x-relay-rotate": "1", "x-relay-egress": "203.0.113.9" },
        }),
    )

    const result = await made.tester.test(made.id, "api")

    expect(result.ok).toBe(false)
    expect(result.status).toBe("exhausted")
    expect(made.state.exit(made.id)?.status).toBe("exhausted")
    expect(made.state.exit(made.id)?.exhaustedUntil ?? 0).toBeGreaterThan(Date.now())
    expect(made.state.exhaustedExits()).toContain(made.id)
  })
})

describe("the deep check", () => {
  test("a real chat answer makes the exit ready", async () => {
    const made = await modelServer(() =>
      json({
        id: "chat-1",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
      }),
    )
    made.state.noteSample({
      modelID: "iceman-free",
      path: "/inference/openai/v1/chat/completions",
      headers: { authorization: "Bearer test-token" },
    })

    const result = await made.tester.test(made.id, "deep")

    expect(result.ok).toBe(true)
    expect(result.status).toBe("ready")
    expect(result.code).toBe(200)
    expect(made.state.exit(made.id)?.status).toBe("ready")
  })

  test("a 200 HTML auth portal is not a model answer", async () => {
    const made = await modelServer(
      () =>
        new Response("<html><body>Sign in to continue</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    )
    made.state.noteSample({
      modelID: "iceman-free",
      path: "/inference/openai/v1/chat/completions",
      headers: { authorization: "Bearer test-token" },
    })

    const result = await made.tester.test(made.id, "deep")

    expect(result.ok).toBe(false)
    expect(result.status).toBe("bad")
    expect(result.note).toContain("model response")
    expect(made.state.exit(made.id)?.status).toBe("bad")
  })

  test("an empty 200 is not a model answer", async () => {
    const made = await modelServer(() => new Response("", { status: 200 }))
    made.state.noteSample({
      modelID: "iceman-free",
      path: "/inference/openai/v1/chat/completions",
      headers: { authorization: "Bearer test-token" },
    })

    const result = await made.tester.test(made.id, "deep")

    expect(result.ok).toBe(false)
    expect(result.status).toBe("bad")
  })

  test("a redirect is not a model answer", async () => {
    const made = await modelServer(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://login.example.com/" },
        }),
    )
    made.state.noteSample({
      modelID: "iceman-free",
      path: "/inference/openai/v1/chat/completions",
      headers: { authorization: "Bearer test-token" },
    })

    const result = await made.tester.test(made.id, "deep")

    expect(result.ok).toBe(false)
    expect(result.status).toBe("bad")
    expect(result.code).toBe(302)
  })

  test("a 204 answer is not a model answer", async () => {
    const made = await modelServer(() => new Response(null, { status: 204 }))
    made.state.noteSample({
      modelID: "iceman-free",
      path: "/inference/openai/v1/chat/completions",
      headers: { authorization: "Bearer test-token" },
    })

    const result = await made.tester.test(made.id, "deep")

    expect(result.ok).toBe(false)
    expect(result.status).toBe("bad")
    expect(result.code).toBe(204)
  })

  test("a deep test with no captured request sends nothing and changes nothing", async () => {
    let reached = false
    const made = await setup(() => {
      reached = true
      return new Response("{}", { status: 200 })
    })

    const result = await made.tester.test(made.id, "deep")

    expect(result.status).toBe("unknown")
    expect(result.note).toContain("captured")
    expect(reached).toBe(false)
    // Nothing was learned, so the exit keeps the verdict it already had.
    expect(made.state.exit(made.id)?.status).toBe("untested")
  })
})

describe("overlapping checks", () => {
  test("an older check cannot retire an exit a newer check cleared", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let arrived!: () => void
    const firstArrived = new Promise<void>((resolve) => {
      arrived = resolve
    })
    let requests = 0

    const made = await setup(async () => {
      requests += 1
      if (requests === 1) {
        arrived()
        await gate
        return new Response("{}", { status: 409, headers: { "x-relay-rotate": "1" } })
      }
      return new Response("{}", { status: 200 })
    })

    // An egress on record makes a stale spend mark visible, and a newer
    // verdict makes the stale one easy to spot.
    await made.state.setHealth(made.id, {
      status: "reachable",
      egress: "203.0.113.9",
      checkedAt: Date.now(),
    })

    const older = made.tester.test(made.id, "api")
    await firstArrived
    await Bun.sleep(5)
    const newer = await made.tester.test(made.id, "api")

    expect(newer.status).toBe("reachable")
    release()
    const stale = await older

    // The old answer still says what it saw, but it must not have retired the
    // exit the newer answer had already cleared.
    expect(stale.status).toBe("exhausted")
    expect(made.state.exit(made.id)?.status).toBe("reachable")
    expect(made.state.exit(made.id)?.exhaustedUntil).toBeUndefined()
    expect(made.state.spentEgresses()).toEqual([])
    expect(made.state.exhaustedExits()).toEqual([])
  })

  test("a live failure during a check wins over the check's answer", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let arrived!: () => void
    const firstArrived = new Promise<void>((resolve) => {
      arrived = resolve
    })

    const made = await setup(async () => {
      arrived()
      await gate
      return new Response("{}", { status: 200 })
    })

    // The check starts, and while it waits a real request through the exit is
    // refused. That verdict is newer evidence than anything the check can say.
    const check = made.tester.test(made.id, "api")
    await firstArrived
    made.state.markBlocked(made.id, "OpenCode refused this exit (HTTP 403).")
    release()
    const result = await check

    expect(result.status).toBe("reachable")
    expect(made.state.exit(made.id)?.status).toBe("blocked")
    expect(made.state.coolingExits()).toContain(made.id)
  })

  test("a rotate 409 during a check keeps the exit exhausted", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let arrived!: () => void
    const firstArrived = new Promise<void>((resolve) => {
      arrived = resolve
    })

    const made = await setup(async () => {
      arrived()
      await gate
      return new Response("{}", { status: 200 })
    })

    const check = made.tester.test(made.id, "api")
    await firstArrived
    const until = Date.now() + 60 * 60_000
    // While the check waits, a real request through the exit hits a rotate 409.
    made.state.markExhausted(made.id, until, "The address behind this relay is used up.")
    release()
    const result = await check

    // The check still reports what it saw, but its answer must not clear a
    // verdict that arrived while it was in flight.
    expect(result.status).toBe("reachable")
    expect(made.state.exit(made.id)?.status).toBe("exhausted")
    expect(made.state.exit(made.id)?.exhaustedUntil).toBe(until)
    expect(made.state.exhaustedExits()).toContain(made.id)
  })
})

describe("the background tester", () => {
  test("runs again after it was stopped", async () => {
    const made = await setup(() => new Response("{}", { status: 200 }))
    made.tester.stop()

    // A reused tester must not stay silently stopped: this scan would finish
    // without checking anything otherwise.
    made.tester.start(60_000)
    await made.tester.scan("api")
    made.tester.stop()

    expect(made.state.exit(made.id)?.status).toBe("reachable")
  })

  test("an exit added while the scan runs is checked by the same scan", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let arrived!: () => void
    const firstArrived = new Promise<void>((resolve) => {
      arrived = resolve
    })

    const made = await setup(async () => {
      arrived()
      await gate
      return new Response("{}", { status: 200 })
    })

    const scanning = made.tester.scan("api")
    await firstArrived

    // A second exit lands while the first check is still in flight - the way
    // a paste or a deploy finishes behind a running background check. The old
    // scan copied its queue once and would have left this one untested.
    const second = await made.state.addRelay({
      kind: "relay",
      id: "relay-2",
      name: "late",
      project: "",
      region: "",
      url: made.state.exit(made.id)?.url ?? "",
      access: "test-access",
      accountId: "",
      enabled: true,
      status: "untested",
      createdAt: Date.now(),
    })

    release()
    await scanning
    await made.tester.scan("api")

    // Both ends are checked: the late exit by the drain of the first scan or
    // the second one, never left "not tested" behind a finished run.
    expect(made.state.exit(second.id)?.status).not.toBe("untested")
    expect(made.state.exit(made.id)?.status).toBe("reachable")
  })
})

describe("a ping", () => {
  test("is stamped when the probe started, not when it finished", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let arrived!: () => void
    const firstArrived = new Promise<void>((resolve) => {
      arrived = resolve
    })

    const made = await setup(async () => {
      arrived()
      await gate
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    })

    const ping = made.tester.test(made.id, "ping")
    await firstArrived
    await Bun.sleep(25)
    const releasedAt = Date.now()
    release()
    const result = await ping

    expect(result.ok).toBe(true)
    const lastCheck = made.state.exit(made.id)?.lastCheck
    expect(lastCheck).toBeDefined()
    // A probe stamped at completion would be at or after the moment it was
    // released, which would let it overwrite a verdict that arrived while it
    // was waiting.
    expect(lastCheck as number).toBeLessThan(releasedAt)
  })
})

describe("a proxy ping", () => {
  /** A proxy exit record pointing at a loopback SOCKS bridge that was made earlier. */
  function proxyExit(url: string) {
    return {
      kind: "proxy" as const,
      id: "proxy-1",
      name: "local proxy",
      url,
      enabled: true,
      status: "untested" as const,
      createdAt: Date.now(),
    }
  }

  /**
   * A SOCKS5 upstream whose tunnel ends in a TLS endpoint answering like the
   * trace service. The tunnel's TLS is ended by the stub itself with a
   * self-signed certificate, so verification must be off while the test runs;
   * the stub is closed afterwards.
   */
  async function traceStub(answer: () => { status: number; body: string }) {
    const { closeServer, stubServer, KEY, CERT } = await tlsStubParts()
    const server = await stubServer((socket) => {
      let greeted = false
      let replied = false
      socket.on("data", (chunk: Buffer) => {
        if (!greeted) {
          greeted = true
          socket.write(Buffer.from([0x05, 0x00]))
          return
        }
        if (replied) return
        replied = true
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x1f, 0x90]))
        const tlsSocket = new tls.TLSSocket(socket, {
          isServer: true,
          key: KEY,
          cert: CERT,
        })
        tlsSocket.on("data", (data: Buffer) => {
          const text = data.toString("latin1")
          if (text.startsWith("GET") || text.startsWith("POST")) {
            const { status, body } = answer()
            tlsSocket.write(
              `HTTP/1.1 ${status} x\r\ncontent-type: text/plain\r\n\r\n${body}`,
            )
            tlsSocket.end()
          }
        })
        tlsSocket.on("error", () => {})
      })
    })
    return {
      port: server.port,
      stop: async () => {
        await closeServer(server.server)
      },
    }
  }

  test("a trace answer makes the proxy reachable", async () => {
    const stub = await traceStub(() => ({ status: 200, body: "ip=203.0.113.7\n" }))
    const made = await setup(() => new Response("{}", { status: 200 }))
    await made.state.addProxy(proxyExit(`socks5://127.0.0.1:${stub.port}`))
    const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"
    try {
      const result = await made.tester.test("proxy-1", "ping")
      expect(result.ok).toBe(true)
      expect(result.status).toBe("reachable")
      expect(result.code).toBe(200)
      expect(result.egress).toBe("203.0.113.7")
    } finally {
      if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls
      await stub.stop()
    }
  })

  test("a 200 without the trace body is not a reachable proxy", async () => {
    const stub = await traceStub(() => ({
      status: 200,
      body: "<html>Welcome to the captive portal</html>",
    }))
    const made = await setup(() => new Response("{}", { status: 200 }))
    await made.state.addProxy(proxyExit(`socks5://127.0.0.1:${stub.port}`))
    const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"
    try {
      const result = await made.tester.test("proxy-1", "ping")
      expect(result.ok).toBe(false)
      expect(result.status).toBe("unreachable")
      expect(result.code).toBe(200)
      expect(result.note).toBe("The proxy answered with HTTP 200 but not with the expected trace.")
      expect(made.state.exit("proxy-1")?.status).toBe("unreachable")
    } finally {
      if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls
      await stub.stop()
    }
  })
})
