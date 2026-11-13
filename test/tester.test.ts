import { afterEach, describe, expect, test } from "bun:test"
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

  test("401 and 403 block the exit", async () => {
    for (const status of [401, 403]) {
      const made = await setup(() => new Response("{}", { status }))
      const result = await made.tester.test(made.id, "api")

      expect(result.status).toBe("blocked")
      expect(result.code).toBe(status)
      expect(made.state.exit(made.id)?.status).toBe("blocked")
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

    const result = await made.tester.test(made.id, "deep")

    expect(result.ok).toBe(false)
    expect(result.status).toBe("bad")
    expect(result.note).toContain("model response")
    expect(made.state.exit(made.id)?.status).toBe("bad")
  })

  test("an empty 200 is not a model answer", async () => {
    const made = await modelServer(() => new Response("", { status: 200 }))

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

    const result = await made.tester.test(made.id, "deep")

    expect(result.ok).toBe(false)
    expect(result.status).toBe("bad")
    expect(result.code).toBe(302)
  })

  test("a 204 answer is not a model answer", async () => {
    const made = await modelServer(() => new Response(null, { status: 204 }))

    const result = await made.tester.test(made.id, "deep")

    expect(result.ok).toBe(false)
    expect(result.status).toBe("bad")
    expect(result.code).toBe(204)
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
