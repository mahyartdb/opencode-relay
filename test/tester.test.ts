import { afterEach, describe, expect, test } from "bun:test"
import net from "node:net"
import tls from "node:tls"
import { readFileSync } from "node:fs"
import type { RelayRecord } from "../src/lib/types.ts"
import { createHandlers } from "../src/server/handlers.ts"
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

/**
 * Poll until the condition holds, and fail with a note when the deadline
 * passes. The follow-up check of an edited address is fire-and-forget, so the
 * event to await is the state changing, whenever it lands.
 */
async function waitFor(condition: () => boolean, withinMs = 5_000): Promise<void> {
  const deadline = Date.now() + withinMs
  for (;;) {
    if (condition()) return
    if (Date.now() >= deadline) throw new Error("the condition never held within the deadline")
    await Bun.sleep(25)
  }
}

/**
 * A SOCKS5 upstream whose tunnel ends in a TLS endpoint answering like the
 * trace service. The tunnel's TLS is ended by the stub itself with a
 * self-signed certificate, so verification must be off while the test runs;
 * the stub is closed afterwards. A `gate`, when given, holds the answer back
 * until it resolves, so a check through the stub stays in flight.
 */
async function traceStub(answer: () => { status: number; body: string }, gate?: Promise<void>) {
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
      tlsSocket.on("data", async (data: Buffer) => {
        const text = data.toString("latin1")
        if (text.startsWith("GET") || text.startsWith("POST")) {
          if (gate !== undefined) await gate
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

  test("a stale exhausted verdict must not spend the egress or arm a cooldown", async () => {
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
      // The check itself answers rotate-409, an exhausted verdict that would
      // spend the egress address and arm the exit's own rest if it were fresh.
      return new Response("{}", {
        status: 409,
        headers: { "x-relay-rotate": "1", "x-relay-egress": "203.0.113.9" },
      })
    })

    const check = made.tester.test(made.id, "api")
    await firstArrived
    const until = Date.now() + 60 * 60_000
    // A live verdict bumps the epoch mid-check: the check's answer, no matter
    // what it saw, is older evidence than this.
    made.state.markExhausted(made.id, until, "A real request was refused.")
    release()
    const result = await check

    expect(result.status).toBe("exhausted")
    // The verdict is stale, so it must not spend the egress address the stub
    // named, nor push the exit's own rest out from the live one.
    expect(made.state.spentEgresses()).toEqual([])
    expect(made.state.exit(made.id)?.exhaustedUntil).toBe(until)
    expect(made.state.exhaustedExits()).toContain(made.id)
  })
})

describe("a check that is already running", () => {
  /** A tester whose server holds the first answer until the test releases it. */
  async function held() {
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
      }
      return new Response("{}", { status: 200 })
    })
    const handlers = createHandlers({
      state: made.state,
      catalog: {} as never,
      bridge: {} as never,
      tester: made.tester,
      announce: async () => {},
    })
    return {
      ...made,
      handlers,
      release,
      firstArrived,
      requests: () => requests,
    }
  }

  test("a second test of the same exit is refused, and the first still finishes", async () => {
    const made = await held()

    const first = made.handlers.testExit({ id: made.id }, {} as never)
    await made.firstArrived
    const second = (await made.handlers.testExit({ id: made.id }, {} as never)) as {
      ok: boolean
      status: string
      code: number
      ms: number
      note?: string
    }

    // The contract has no refused field, so the refusal is a verdict of its
    // own that never reaches the stored state.
    expect(second).toMatchObject({ ok: false, status: "testing", code: 0, ms: 0 })
    expect(second.note).toContain("already being tested")
    expect(made.state.exit(made.id)?.status).toBe("untested")

    made.release()
    const settled = (await first) as { status: string }
    expect(settled.status).toBe("reachable")
  })

  test("the Tester itself refuses a second test of the same exit", async () => {
    const made = await held()

    // The claim lives at test()'s entry, so every caller — the handlers, the
    // sweep, a fire-and-forget check — meets the same guard.
    const first = made.tester.test(made.id, "api")
    await made.firstArrived
    const second = await made.tester.test(made.id, "api")

    // A refused check is a verdict of its own that says nothing ran, not a
    // result dressed up as one.
    expect(second).toMatchObject({ ok: false, status: "testing", code: 0, ms: 0 })
    expect(second.note).toContain("already being tested")
    expect(made.requests()).toBe(1)

    made.release()
    const settled = await first
    expect(settled.status).toBe("reachable")

    // The claim went out with the first check: the exit can be tested again.
    const again = await made.tester.test(made.id, "api")
    expect(again.status).toBe("reachable")
  })

  test("the holder of the running check can be awaited, then the exit re-tested", async () => {
    const made = await held()

    const first = made.tester.test(made.id, "api")
    await made.firstArrived
    const holder = made.tester.inFlightTest(made.id)
    expect(holder).toBeDefined()
    const refused = await made.tester.test(made.id, "api")
    expect(refused).toMatchObject({ ok: false, status: "testing" })

    // A caller that follows the holder instead of racing it can act on the
    // settled verdict — this is what a check fired after an address edit does.
    made.release()
    await holder
    const again = await made.tester.test(made.id, "api")
    expect(again.status).toBe("reachable")
    expect(made.requests()).toBe(2)
  })

  test("the sweep skips the exit a user's test is already checking", async () => {
    const made = await held()

    // The user's test claims the exit first, the way the sweep and a test
    // asked for by name both reach the same address.
    const check = made.handlers.testExit({ id: made.id }, {} as never)
    await made.firstArrived
    await made.tester.scan("api")

    // A second check would have spent the exit's allowance and raced the
    // verdict, and the sweep must finish rather than fail on the claim.
    expect(made.requests()).toBe(1)

    made.release()
    const result = (await check) as { status: string }
    expect(result.status).toBe("reachable")
  })

  test("a check the sweep skips still counts toward the scan's progress", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let arrived!: () => void
    const secondArrived = new Promise<void>((resolve) => {
      arrived = resolve
    })
    // Two exits: one claimed by a user's test, one held mid-answer. The
    // sweep skips the first (counted) and waits on the second, so the
    // fraction is observable while it runs.
    const made = await setup(async () => {
      arrived()
      await gate
      return new Response("{}", { status: 200 })
    })
    const claimed = made.tester.test(made.id, "api")
    await Bun.sleep(25)
    await made.state.addRelay({
      kind: "relay",
      id: "relay-2",
      name: "held",
      project: "",
      region: "",
      url: made.state.exit(made.id)?.url ?? "",
      access: "test-access",
      accountId: "",
      enabled: true,
      status: "untested",
      createdAt: Date.now(),
    })

    const sweeping = made.tester.scan("api")
    await secondArrived
    // The skipped exit was already counted: 1 of 2 done while the second
    // check waits. Without counting the skip, the fraction would sit at 0.
    expect(made.state.scanning()).toMatchObject({ total: 2, done: 1 })

    release()
    await sweeping
    const settled = (await claimed) as { status: string }
    expect(settled.status).toBe("reachable")
  })

  test("a check fired after an address edit follows the holder, then tests the new address", async () => {
    // A held relay whose first answer waits, standing in for the check that
    // holds the claim when a scan is running while the address is edited.
    const made = await held()
    const first = made.handlers.testExit({ id: made.id }, {} as never)
    await made.firstArrived

    // The proxy's first address is the gated trace stub, and its own scan is
    // started through the handler path so it claims the proxy. The edit then
    // moves the address while that check holds the claim: the refusal must be
    // followed by a check of the newest address, not a silent nothing.
    let pass!: () => void
    const gate = new Promise<void>((resolve) => {
      pass = resolve
    })
    const trace = await traceStub(() => ({ status: 200, body: "ip=203.0.113.7\n" }), gate)
    const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"
    try {
      await made.state.addProxy({
        kind: "proxy",
        id: "proxy-1",
        name: "edited",
        url: `socks5://127.0.0.1:${trace.port}`,
        enabled: true,
        status: "untested",
        createdAt: Date.now(),
      })
      const holding = made.tester.test("proxy-1", "ping")
      await waitFor(() => made.tester.inFlightTest("proxy-1") !== undefined)

      // The edit lands while the ping holds the claim. Without following the
      // holder, the fired check would be refused and the new address would
      // never be tested at all.
      const update = made.handlers.updateProxy(
        { id: "proxy-1", url: "socks5://127.0.0.1:9" },
        {} as never,
      )
      expect(((await update) as { updated: boolean }).updated).toBe(true)

      // The holder settles; the follow-up check of the new address then runs
      // against port 9 (nothing listens) and answers unreachable, not the
      // refusal's never-stored no-verdict.
      pass()
      made.release()
      const settled = (await holding) as { status: string }
      expect(settled.status).toBe("reachable")
      const settledFirst = (await first) as { status: string }
      expect(settledFirst.status).toBe("reachable")

      await waitFor(() => made.state.exit("proxy-1")?.status !== "untested")
      // Port 9 refuses the tunnel, the local bridge answers 502, and the api
      // check calls that a failing exit: a verdict, where the refusal alone
      // would have left the address untested forever.
      expect(made.state.exit("proxy-1")?.status).toBe("bad")
    } finally {
      if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls
      await trace.stop()
    }
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
