import { describe, expect, test } from "bun:test"
import { relayRequest } from "../src/lib/routing.ts"
import type { ProxyRecord, RelayRecord } from "../src/lib/types.ts"
import { registerHooks, ROTATE_DELAY_MS } from "../src/server/hooks.ts"
import { RelayState, StorageError, COOLDOWN_BASE_MS } from "../src/server/state.ts"

/**
 * The state rules that keep an exit from serving when it should not.
 *
 * These tests drive the state directly, without a network: the interesting
 * behaviour is the bookkeeping, and every request here would be a real one
 * otherwise.
 */

/** The in-memory stand-in for the plugin's storage. */
function memoryStorage() {
  const store = new Map<string, unknown>()
  return {
    store,
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

async function makeState(): Promise<RelayState> {
  const state = new RelayState(memoryStorage() as never)
  await state.load()
  return state
}

/**
 * A storage whose writes to some keys fail, as a full disk would.
 *
 * The keys are named after the setup has been written: the exits have to be
 * on the disk before the disk starts refusing them.
 */
function failingStorage() {
  const store = new Map<string, unknown>()
  const failing = new Set<string>()
  return {
    store,
    fail: (...keys: string[]) => {
      for (const key of keys) failing.add(key)
    },
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => {
      if (failing.has(key)) throw new Error(`ENOSPC: no space left on device (${key})`)
      store.set(key, value)
    },
    remove: async (key: string) => {
      store.delete(key)
    },
    scan: async () => ({ entries: [] }),
  }
}

/**
 * One storage, many states: every new instance only knows what the last one
 * wrote, so loading it is a real restart.
 */
async function makeRestartable() {
  const memory = memoryStorage()
  const spawn = async (): Promise<RelayState> => {
    const state = new RelayState(memory as never)
    await state.load()
    return state
  }
  const state = await spawn()
  const restart = async (): Promise<RelayState> => {
    // Failure verdicts are written without being awaited, so give the pending
    // writes a tick to land before the next process reads them.
    await Bun.sleep(0)
    return spawn()
  }
  return { state, restart, store: memory.store }
}

/** A relay record that only needs its health to be interesting. */
function relay(id: string, name = id): RelayRecord {
  return {
    kind: "relay",
    id,
    name,
    project: id,
    region: "fra1",
    url: `https://${id}.example.com`,
    access: "test-access",
    accountId: "",
    enabled: true,
    status: "untested",
    createdAt: Date.now(),
  }
}

/** A proxy record that only needs its health and its switch to be interesting. */
function proxy(id: string, name = id): ProxyRecord {
  return {
    kind: "proxy",
    id,
    name,
    url: `http://${id}.example.com:8080`,
    enabled: true,
    status: "untested",
    createdAt: Date.now(),
  }
}

/** Add exits and make them usable, so a test can focus on one transition. */
async function readyState(ids: readonly string[]): Promise<RelayState> {
  const state = await makeState()
  for (const id of ids) {
    await state.addRelay(relay(id))
    await state.setHealth(id, { status: "ready" })
  }
  return state
}

type Handler = (input: any) => Promise<void> | void

/** The smallest context that can register session hooks. */
function makeContext() {
  const hooks = new Map<string, Handler>()
  const context = {
    session: {
      hook: async (name: string, callback: Handler) => {
        hooks.set(name, callback)
        return { dispose: async () => {} }
      },
    },
  }
  return { context, hooks }
}

/** Register the real hooks against a real state and no outside world. */
async function makeHooks() {
  const state = await makeState()
  await state.setEnabled(true)
  const made = makeContext()
  await registerHooks(made.context as never, {
    state,
    catalog: { list: async () => [] } as never,
    bridge: { ready: true, origin: "http://127.0.0.1:1", key: "bridge-key" } as never,
    tester: { canary: async () => "inconclusive" } as never,
    announceTraffic: () => {},
  })
  return { state, hooks: made.hooks }
}

/** The free model the routed-hook tests send, so the request hook has a way out. */
const freeModel = { id: "iceman-free", name: "Iceman", cost: [{ input: 0, output: 0 }] }

/** Register the real hooks over a catalog that can route, so a request leaves through an exit. */
async function makeRoutedHooks() {
  const state = await makeState()
  await state.setEnabled(true)
  const made = makeContext()
  await registerHooks(made.context as never, {
    state,
    catalog: {
      list: async () => [freeModel],
      resolve: (models: readonly { id: string; name: string }[], id: string) =>
        models.find((model) => model.id === id) ?? { id, name: id },
    } as never,
    bridge: { ready: true, origin: "http://127.0.0.1:1", key: "bridge-key" } as never,
    tester: { canary: async () => "inconclusive" } as never,
    announceTraffic: () => {},
  })
  return { state, hooks: made.hooks }
}

/** One request of a session, told apart by the kind OpenCode sends beside its agent loop. */
function routedRequest(kind: "primary" | "title") {
  return {
    sessionID: "session-title",
    model: { id: freeModel.id, providerID: "opencode" },
    kind,
    request: new Request("https://opencode.ai/inference/openai/v1/models"),
  }
}

/** A request as the plugin would send it through one relay. */
function requestFor(id: string): Request {
  return relayRequest(new Request("https://opencode.ai/inference/openai/v1/models"), {
    url: "https://relay.example.com",
    access: "test-access",
    id,
  })
}

function responseInput(
  sessionID: string,
  id: string,
  status: number,
  headers?: Record<string, string>,
) {
  return {
    sessionID,
    model: { id: "iceman-free", providerID: "opencode" },
    request: requestFor(id),
    response: new Response("{}", { status, ...(headers !== undefined ? { headers } : {}) }),
  }
}

describe("a limited exit", () => {
  test("rests for its cooldown, then serves again without a reset", async () => {
    const state = await readyState(["relay-1"])
    const id = "relay-1"

    state.markRateLimited(id, Date.now() + 60_000, "OpenCode rate-limited this exit.")
    expect(state.exit(id)?.status).toBe("limited")
    expect(state.coolingExits()).toContain(id)
    expect(state.pickExit({ advance: false }).exit).toBeUndefined()

    // The cooldown passed, not the status: the exit is usable again even
    // though its last recorded verdict is still "limited".
    state.markRateLimited(id, Date.now() - 1, "OpenCode rate-limited this exit.")
    expect(state.pickExit({ advance: false }).exit?.id).toBe(id)
    expect(state.coolingExits()).toEqual([])
  })
})

describe("a live failure", () => {
  test("rests for its cooldown, then is tried again", async () => {
    const state = await readyState(["relay-1"])
    const now = Date.now()

    state.markFailure("relay-1", "The exit did not answer.", "unreachable")
    expect(state.exit("relay-1")?.status).toBe("unreachable")
    expect(state.coolingExits()).toContain("relay-1")
    expect(state.pickExit({ advance: false }).exit).toBeUndefined()

    // Still inside the first two-minute rest.
    expect(state.pickExit({ advance: false, now: now + 60_000 }).exit).toBeUndefined()

    // The rest passed, so the exit is worth another try: its last status is
    // still "unreachable", but that must not retire it for good.
    expect(
      state.pickExit({ advance: false, now: now + COOLDOWN_BASE_MS + 5_000 }).exit?.id,
    ).toBe("relay-1")
  })

  test("a blocked exit gets the same rest", async () => {
    const state = await readyState(["relay-1"])
    const now = Date.now()

    state.markBlocked("relay-1", "OpenCode refused this exit (HTTP 403).")
    expect(state.exit("relay-1")?.status).toBe("blocked")
    expect(state.pickExit({ advance: false }).exit).toBeUndefined()

    expect(
      state.pickExit({ advance: false, now: now + COOLDOWN_BASE_MS + 5_000 }).exit?.id,
    ).toBe("relay-1")
  })

  test("a failure verdict from a test waits for another test", async () => {
    const state = await readyState(["relay-1"])
    const now = Date.now()

    await state.setHealth("relay-1", { status: "bad", lastError: "HTTP 500", checkedAt: now })
    expect(state.pickExit({ advance: false }).exit).toBeUndefined()

    // No live failure armed a rest, so passing time does not bring it back.
    expect(
      state.pickExit({ advance: false, now: now + 24 * 60 * 60_000 }).exit,
    ).toBeUndefined()
  })

  test("a used-up exit stays rejected until its reset", async () => {
    const state = await readyState(["relay-1"])
    const now = Date.now()

    await state.setHealth("relay-1", {
      status: "exhausted",
      exhaustedUntil: now + 60_000,
      checkedAt: now,
    })
    expect(state.pickExit({ advance: false }).exit).toBeUndefined()

    expect(state.pickExit({ advance: false, now: now + 59_000 }).exit).toBeUndefined()
    expect(state.pickExit({ advance: false, now: now + 61_000 }).exit?.id).toBe("relay-1")
  })

  test("a limited exit stays rejected until its cooldown", async () => {
    const state = await readyState(["relay-1"])
    const now = Date.now()

    state.markRateLimited("relay-1", now + 60_000, "OpenCode rate-limited this exit.")
    expect(state.pickExit({ advance: false }).exit).toBeUndefined()

    expect(state.pickExit({ advance: false, now: now + 59_000 }).exit).toBeUndefined()
    expect(state.pickExit({ advance: false, now: now + 61_000 }).exit?.id).toBe("relay-1")
  })
})

describe("across a restart", () => {
  test("a live failure keeps its rest, and the exit serves once it is over", async () => {
    const { state, restart } = await makeRestartable()
    await state.addRelay(relay("relay-1"))
    await state.setHealth("relay-1", { status: "ready" })

    const now = Date.now()
    state.markFailure("relay-1", "The exit did not answer.", "unreachable")

    const next = await restart()
    // The failure was live, so the exit rests rather than retires — but the
    // rest is only known to the new process if it was written with the status.
    expect(next.pickExit({ advance: false }).exit).toBeUndefined()
    expect(next.coolingExits()).toContain("relay-1")

    // When the rest ends, the same exit serves again without another test.
    const later = await next.pickExit({ advance: false, now: now + COOLDOWN_BASE_MS + 5_000 })
    expect(later.exit?.id).toBe("relay-1")
  })

  test("a success after a live failure survives the restart", async () => {
    const { state, restart } = await makeRestartable()
    await state.addRelay(relay("relay-1"))
    await state.setHealth("relay-1", { status: "ready" })

    state.markFailure("relay-1", "The exit did not answer.", "unreachable")
    state.markSuccess("relay-1", 120)

    const next = await restart()
    expect(next.exit("relay-1")?.status).toBe("ready")
    expect(next.pickExit({ advance: false }).exit?.id).toBe("relay-1")
  })

  test("pausing an exit does not clear its rest", async () => {
    const { state, restart } = await makeRestartable()
    await state.addRelay(relay("relay-1"))
    await state.setHealth("relay-1", { status: "ready" })

    const now = Date.now()
    state.markFailure("relay-1", "The exit did not answer.", "unreachable")
    await state.setExitEnabled("relay-1", false)
    await state.setExitEnabled("relay-1", true)

    const next = await restart()
    expect(next.pickExit({ advance: false }).exit).toBeUndefined()

    const later = await next.pickExit({ advance: false, now: now + COOLDOWN_BASE_MS + 5_000 })
    expect(later.exit?.id).toBe("relay-1")
  })

  test("a rate limit keeps its cooldown across a restart", async () => {
    const { state, restart } = await makeRestartable()
    await state.addRelay(relay("relay-1"))
    await state.setHealth("relay-1", { status: "ready" })

    const now = Date.now()
    state.markRateLimited("relay-1", now + 60_000, "OpenCode rate-limited this exit.")

    const next = await restart()
    // The restart lands inside the cooldown, so the exit stays skipped.
    expect(next.pickExit({ advance: false }).exit).toBeUndefined()

    // At the cooldown's end the exit serves again, on the strength of its
    // persisted rest.
    expect(next.pickExit({ advance: false, now: now + 61_000 }).exit?.id).toBe("relay-1")
  })

  test("a test verdict still waits for another test", async () => {
    const { state, restart } = await makeRestartable()
    await state.addRelay(relay("relay-1"))
    await state.setHealth("relay-1", { status: "ready" })

    const now = Date.now()
    await state.setHealth("relay-1", { status: "bad", lastError: "HTTP 500", checkedAt: now })

    const next = await restart()
    expect(next.pickExit({ advance: false }).exit).toBeUndefined()
    expect(
      next.pickExit({ advance: false, now: now + 24 * 60 * 60_000 }).exit,
    ).toBeUndefined()
  })

  test("changing a proxy's URL starts its record over", async () => {
    const { state, store } = await makeRestartable()
    await state.addRelay(relay("relay-1"))
    await state.setHealth("relay-1", { status: "ready" })

    const proxy = await state.addProxy({
      kind: "proxy",
      id: "proxy-1",
      name: "proxy",
      url: "http://1.2.3.4:8080",
      enabled: true,
      status: "ready",
      latencyMs: 42,
      lastCheck: Date.now(),
      egress: "1.2.3.4",
      runtime: "bun",
      createdAt: Date.now(),
    })
    // The record carries a live failure's rest, seeded the way one is armed:
    // with a real failure, so the test proves the very fields markFailure
    // stamps are the ones a URL change drops.
    state.markFailure(proxy.id, "The exit did not answer.", "unreachable")
    expect(state.proxy(proxy.id)?.coolingUntil).toBeDefined()
    expect(state.proxy(proxy.id)?.failures).toBe(1)
    await state.setExitEnabled(proxy.id, false)

    const updated = await state.updateProxy(proxy.id, {
      name: "moved",
      url: "socks5://9.9.9.9:1080",
    })
    expect(updated).toMatchObject({
      kind: "proxy",
      id: "proxy-1",
      name: "moved",
      url: "socks5://9.9.9.9:1080",
      enabled: false,
      status: "untested",
      createdAt: proxy.createdAt,
    })
    expect(updated?.lastError).toBeUndefined()
    expect(updated?.lastCheck).toBeUndefined()
    expect(updated?.latencyMs).toBeUndefined()
    expect(updated?.egress).toBeUndefined()
    expect(updated?.runtime).toBeUndefined()
    expect(updated?.coolingUntil).toBeUndefined()
    expect(updated?.failures).toBeUndefined()
    expect(updated?.exhaustedUntil).toBeUndefined()

    // Nothing stale is left on disk either: the next restart reads the new
    // record exactly as the running process wrote it.
    const persisted = (store.get("proxies") as (Record<string, unknown> | undefined)[])?.find(
      (entry) => entry?.id === "proxy-1",
    )
    expect(persisted).toMatchObject({ status: "untested" })
    expect(persisted?.lastError).toBeUndefined()
    expect(persisted?.latencyMs).toBeUndefined()
    expect(persisted?.egress).toBeUndefined()
    expect(persisted?.runtime).toBeUndefined()
    expect(persisted?.coolingUntil).toBeUndefined()
    expect(persisted?.failures).toBeUndefined()
    expect(persisted?.exhaustedUntil).toBeUndefined()

    // A name-only edit is not a new exit: the record keeps what it knows.
    const renamed = await state.updateProxy(proxy.id, { name: "renamed" })
    expect(renamed).toMatchObject({
      name: "renamed",
      url: "socks5://9.9.9.9:1080",
      status: "untested",
      enabled: false,
      createdAt: proxy.createdAt,
    })
  })

  test("a rename keeps the counters and the rest that a URL change would drop", async () => {
    const { state } = await makeRestartable()
    const proxy = await state.addProxy({
      kind: "proxy",
      id: "proxy-1",
      name: "proxy",
      url: "http://1.2.3.4:8080",
      enabled: true,
      status: "ready",
      createdAt: Date.now(),
    })
    state.noteRequest(proxy.id)
    state.noteRequest(proxy.id)
    state.markFailed(proxy.id)
    // A live failure, armed the way the hooks arm it.
    state.markFailure(proxy.id, "The exit did not answer.", "unreachable")

    await state.updateProxy(proxy.id, { name: "just renamed" })

    // A rename is the same machine behind the same address, so the counters,
    // the verdict and the armed rest all survive it. Dropping them here would
    // make a resting proxy usable again without anything changing but its
    // name.
    expect(state.proxy(proxy.id)?.status).toBe("unreachable")
    expect(state.proxy(proxy.id)?.failures).toBe(1)
    expect(state.proxy(proxy.id)?.lastError).toBe("The exit did not answer.")
    expect(state.statsFor(proxy.id).requests).toBe(2)
    expect(state.statsFor(proxy.id).failed).toBe(1)
    expect(state.pickExit({ advance: false }).exit).toBeUndefined()
    expect(
      state.pickExit({ advance: false, now: Date.now() + 5 * 60_000 }).exit?.id,
    ).toBe(proxy.id)
  })

  test("a success clears the failure note a previous verdict left behind", async () => {
    const state = await readyState(["relay-1"])
    state.markFailure("relay-1", "The exit did not answer.", "unreachable")
    expect(state.summaryOf("relay-1")?.lastError).toContain("did not answer")

    state.markSuccess("relay-1", 90)

    const summary = state.summaryOf("relay-1")
    expect(summary?.status).toBe("ready")
    // A healthy record that still carried the old error's text would have the
    // details page show a failure under a ready status.
    expect(summary?.lastError).toBeUndefined()
  })

  test("a passing check drops the previous failure's note", async () => {
    const state = await readyState(["relay-1"])
    await state.setHealth("relay-1", {
      status: "bad",
      lastError: "The exit answered with HTTP 500.",
      checkedAt: Date.now(),
    })
    expect(state.summaryOf("relay-1")?.lastError).toContain("500")

    await state.setHealth("relay-1", { status: "ready", checkedAt: Date.now() })

    expect(state.summaryOf("relay-1")?.status).toBe("ready")
    expect(state.summaryOf("relay-1")?.lastError).toBeUndefined()
  })

  test("the rotation does not serve one exit twice when another comes back", async () => {
    const { state } = await makeRestartable()
    await state.addRelay(relay("relay-a"))
    await state.addRelay(relay("relay-b"))
    await state.addRelay(relay("relay-c"))
    await state.setEnabled(true)
    await state.setStrategy("round-robin")
    await state.setHealth("relay-a", { status: "ready" })
    await state.setHealth("relay-b", { status: "ready" })
    await state.setHealth("relay-c", { status: "ready" })

    const first = state.pickExit({ advance: true }).exit?.id
    const second = state.pickExit({ advance: true }).exit?.id
    expect(first).toBe("relay-a")
    expect(second).toBe("relay-b")

    // The middle exit rests and comes back. The rotation stands where it was,
    // so the exit that comes back is served in turn rather than twice.
    state.markFailure("relay-b", "The exit did not answer.", "unreachable")
    const duringRest = state.pickExit({ advance: true }).exit?.id
    expect(duringRest).toBe("relay-c")

    const later = state.pickExit({ advance: true, now: Date.now() + 10 * 60_000 }).exit?.id
    expect(later).toBe("relay-a")
  })

  test("choosing an exit starts the rotation there", async () => {
    const { state } = await makeRestartable()
    await state.addRelay(relay("relay-a"))
    await state.addRelay(relay("relay-b"))
    await state.addRelay(relay("relay-c"))
    await state.setEnabled(true)
    await state.setStrategy("round-robin")
    await state.setHealth("relay-a", { status: "ready" })
    await state.setHealth("relay-b", { status: "ready" })
    await state.setHealth("relay-c", { status: "ready" })

    // The chosen exit is where the rotation starts, not wherever the last
    // request happened to leave it.
    await state.setActiveExit("relay-c")
    expect(state.pickExit({ advance: true }).exit?.id).toBe("relay-c")
    expect(state.pickExit({ advance: true }).exit?.id).toBe("relay-a")
  })

  test("a rate limit rests an exit for a bounded time, whatever the header said", async () => {
    const { state } = await makeRestartable()
    await state.addRelay(relay("relay-1"))
    await state.setHealth("relay-1", { status: "ready" })

    // A Retry-After of years must not bench the exit for years: it would
    // only ever be lifted by another test.
    state.markRateLimited("relay-1", Date.now() + 365 * 24 * 60 * 60_000, "OpenCode rate-limited this exit.")

    const cooling = state.exit("relay-1")?.coolingUntil
    expect(cooling).toBeDefined()
    expect(cooling as number).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60_000)
  })

  test("a failed write is reported, not passed off as saved", async () => {
    const store = new Map<string, unknown>()
    const storage = {
      store,
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => {
        // The disk is full: the change is in memory but never on disk.
        if (key === "relays") throw new Error("ENOSPC: no space left on device")
        store.set(key, value)
      },
      remove: async (key: string) => {
        store.delete(key)
      },
      scan: async () => ({ entries: [] }),
    }
    const state = new RelayState(storage as never)
    await state.load()

    // A change that could not be saved must say so: the caller has to know
    // that the next restart would undo it.
    let failed: unknown
    try {
      await state.addRelay(relay("relay-1"))
    } catch (error) {
      failed = error
    }
    expect(failed).toBeInstanceOf(StorageError)
    expect((failed as StorageError).key).toBe("relays")
    expect((failed as StorageError).message).toContain("relays")
    expect((failed as StorageError).message).toContain("ENOSPC")
  })

  test("a used-up exit stays used up until something proves the allowance is back", async () => {
    const { state } = await makeRestartable()
    await state.addRelay(relay("relay-1"))
    await state.setHealth("relay-1", { status: "ready" })

    const until = Date.now() + 60 * 60_000
    await state.setHealth("relay-1", { status: "exhausted", exhaustedUntil: until })

    // The model list answers even when the chat allowance is gone, so a check
    // that only asked for it must not lift the latch.
    await state.setHealth("relay-1", { status: "reachable" })
    expect(state.exit("relay-1")?.status).toBe("exhausted")
    expect(state.exit("relay-1")?.exhaustedUntil).toBe(until)

    // A real model answer through the exit proves it, and lifts the latch.
    await state.setHealth("relay-1", { status: "ready" })
    expect(state.exit("relay-1")?.status).toBe("ready")
  })

  test("a verdict that proves nothing leaves a resting exit alone", async () => {
    const { state } = await makeRestartable()
    await state.addRelay(relay("relay-1"))
    await state.setHealth("relay-1", { status: "ready" })
    state.markFailure("relay-1", "The exit did not answer.", "unreachable")
    expect(state.exit("relay-1")?.status).toBe("unreachable")

    // A check that could not tell must not revive the exit: the next request
    // would land on it again.
    const changed = await state.setHealth("relay-1", { status: "unknown" })
    expect(changed).toBe(false)
    expect(state.exit("relay-1")?.status).toBe("unreachable")
  })

  test("a failed write takes the change back with it", async () => {
    const store = new Map<string, unknown>()
    const storage = {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => {
        if (key === "relays") throw new Error("ENOSPC: no space left on device")
        store.set(key, value)
      },
      remove: async (key: string) => {
        store.delete(key)
      },
      scan: async () => ({ entries: [] }),
    }
    const state = new RelayState(storage as never)
    await state.load()

    await state.addRelay(relay("relay-1")).catch(() => {})

    // The relay is not on the disk, so it must not be in memory either: a
    // reader would see an exit that the next restart would lose.
    expect(state.relays()).toHaveLength(0)
  })

  test("the rotation carries on where it was after a restart", async () => {
    const { state, restart } = await makeRestartable()
    await state.addRelay(relay("relay-a"))
    await state.addRelay(relay("relay-b"))
    await state.addRelay(relay("relay-c"))
    await state.setEnabled(true)
    await state.setStrategy("round-robin")
    await state.setHealth("relay-a", { status: "ready" })
    await state.setHealth("relay-b", { status: "ready" })
    await state.setHealth("relay-c", { status: "ready" })

    expect(state.pickExit({ advance: true }).exit?.id).toBe("relay-a")
    expect(state.pickExit({ advance: true }).exit?.id).toBe("relay-b")
    await Bun.sleep(0)

    // A restart that always started the rotation at the first exit would
    // let that one burn its allowance first every time. The position is
    // written with the rules, so the rotation carries on from where it was.
    const next = await restart()
    await next.setHealth("relay-a", { status: "ready" })
    await next.setHealth("relay-b", { status: "ready" })
    await next.setHealth("relay-c", { status: "ready" })
    const served = next.pickExit({ advance: true }).exit?.id
    expect(served).not.toBe("relay-a")
  })

  test("a live used-up latch outranks a failure verdict", async () => {
    const { state } = await makeRestartable()
    await state.addRelay(relay("relay-1"))
    await state.setHealth("relay-1", { status: "ready" })

    const until = Date.now() + 60 * 60_000
    await state.setHealth("relay-1", { status: "exhausted", exhaustedUntil: until })

    // A transport failure that lands after the exhaustion verdict must not
    // clear the latch: the address has no allowance left, whatever the
    // connection did.
    state.markFailure("relay-1", "The exit did not answer.", "unreachable")

    expect(state.exit("relay-1")?.status).toBe("exhausted")
    expect(state.pickExit({ advance: true }).exit).toBeUndefined()
    const later = state.pickExit({ advance: true, now: Date.now() + 10 * 60_000 })
    expect(later.exit).toBeUndefined()
    expect(later.skipped[0]?.reason).toContain("used up")
  })

  test("the rotation carries on after the exit it served is removed", async () => {
    const { state } = await makeRestartable()
    await state.addRelay(relay("relay-a"))
    await state.addRelay(relay("relay-b"))
    await state.addRelay(relay("relay-c"))
    await state.setEnabled(true)
    await state.setStrategy("round-robin")
    await state.setHealth("relay-a", { status: "ready" })
    await state.setHealth("relay-b", { status: "ready" })
    await state.setHealth("relay-c", { status: "ready" })

    expect(state.pickExit({ advance: true }).exit?.id).toBe("relay-a")
    expect(state.pickExit({ advance: true }).exit?.id).toBe("relay-b")

    // The exit that served last is gone: the rotation carries on with the
    // next one instead of starting over.
    await state.removeExit("relay-b")
    expect(state.pickExit({ advance: true }).exit?.id).toBe("relay-c")
  })

  test("a partial settings object keeps what it says and defaults the rest", async () => {
    const { state, restart, store } = await makeRestartable()
    await state.addRelay(relay("relay-1"))
    await state.addRelay(relay("relay-2"))
    await state.setEnabled(true)
    await state.setStrategy("round-robin")

    // A hand-edited file that names only the plugin switch and the chosen
    // exit: what it says must survive the load, and the rest must default
    // instead of the whole object being dropped for the defaults.
    store.set("settings", { enabled: true, activeExitId: "relay-2" })
    const next = await restart()
    const rules = next.settings()
    expect(rules.enabled).toBe(true)
    expect(rules.selection).toBe("free")
    expect(rules.strategy).toBe("fixed")
    expect(rules.customModels).toEqual([])
    expect(rules.activeExitId).toBe("relay-2")

    // The same file with everything in it still reads back whole.
    store.set("settings", {
      enabled: true,
      selection: "custom",
      customModels: ["iceman-free"],
      activeExitId: "relay-2",
    })
    const full = await restart()
    const kept = full.settings()
    expect(kept.enabled).toBe(true)
    expect(kept.selection).toBe("custom")
    expect(kept.customModels).toEqual(["iceman-free"])
    expect(kept.activeExitId).toBe("relay-2")
  })
})

describe("attribution", () => {
  test("a relayed marker still resolves after ten minutes", async () => {
    const state = await makeState()
    const now = Date.now()

    state.noteRelayed("session-1", "iceman-free", "relay-1")

    expect(state.relayedBy("session-1", "iceman-free", now + 10 * 60_000)).toBe("relay-1")
    // Half an hour later it is no longer this failure's exit.
    expect(state.relayedBy("session-1", "iceman-free", now + 31 * 60_000)).toBeUndefined()
  })
})

describe("a live verdict during a check", () => {
  test("wins over the answer of the check that started before it", async () => {
    const state = await readyState(["relay-1"])
    // What a check saw when it began.
    const epoch = state.healthEpoch("relay-1")
    const checkedAt = Date.now()

    state.markBlocked("relay-1", "OpenCode refused this exit (HTTP 403).")
    const applied = await state.setHealth("relay-1", {
      status: "reachable",
      checkedAt,
      healthEpoch: epoch,
    })

    expect(applied).toBe(false)
    expect(state.exit("relay-1")?.status).toBe("blocked")

    // A check that starts after the verdict carries the new epoch and may
    // clear the exit.
    const fresh = await state.setHealth("relay-1", {
      status: "reachable",
      checkedAt: Date.now(),
      healthEpoch: state.healthEpoch("relay-1"),
    })
    expect(fresh).toBe(true)
    expect(state.exit("relay-1")?.status).toBe("reachable")
  })

  test("a rotate 409 during a check keeps the check from clearing the exit", async () => {
    const state = await readyState(["relay-1"])
    // What a check saw when it began.
    const epoch = state.healthEpoch("relay-1")
    const checkedAt = Date.now()
    const until = Date.now() + 60 * 60_000

    // While the check waits, a real request through the exit hits a rotate 409.
    state.markExhausted("relay-1", until, "The address behind this relay is used up.")

    // The live verdict bumps the epoch and stamps the record, so the older
    // check cannot win with its own answer.
    expect(state.healthEpoch("relay-1")).toBe(epoch + 1)
    expect(state.exit("relay-1")?.lastCheck).toBeGreaterThanOrEqual(checkedAt)

    const applied = await state.setHealth("relay-1", {
      status: "reachable",
      checkedAt,
      healthEpoch: epoch,
    })

    expect(applied).toBe(false)
    expect(state.exit("relay-1")?.status).toBe("exhausted")
    expect(state.exit("relay-1")?.exhaustedUntil).toBe(until)
    expect(state.exhaustedExits()).toContain("relay-1")

    // The reset still brings the exit back on its own.
    expect(state.exhaustedExits(until + 1)).toEqual([])
    expect(state.exit("relay-1")?.status).toBe("reachable")
  })

  test("a success during a check keeps the check's answer from overwriting it", async () => {
    const state = await readyState(["relay-1"])
    const epoch = state.healthEpoch("relay-1")
    const checkedAt = Date.now()

    state.markSuccess("relay-1", 120)

    expect(state.healthEpoch("relay-1")).toBe(epoch + 1)
    // A check whose own timestamp looks newer than the record's still loses:
    // the epoch, not the clock, decides what is stale.
    const applied = await state.setHealth("relay-1", {
      status: "unreachable",
      checkedAt: checkedAt + 1_000,
      healthEpoch: epoch,
    })

    expect(applied).toBe(false)
    expect(state.exit("relay-1")?.status).toBe("ready")
  })
})

describe("setHealth", () => {
  test("ignores an older check so it cannot overwrite a newer verdict", async () => {
    const state = await makeState()
    await state.addRelay(relay("relay-1"))
    const newer = Date.now()

    await state.setHealth("relay-1", { status: "ready", checkedAt: newer })
    const applied = await state.setHealth("relay-1", {
      status: "exhausted",
      exhaustedUntil: newer + 60 * 60_000,
      checkedAt: newer - 1_000,
    })

    expect(applied).toBe(false)
    expect(state.exit("relay-1")?.status).toBe("ready")
    expect(state.exit("relay-1")?.exhaustedUntil).toBeUndefined()
    expect(state.exhaustedExits()).toEqual([])
  })

  test("keeps applying updates from callers that do not stamp a check", async () => {
    const state = await makeState()
    await state.addRelay(relay("relay-1"))

    await state.setHealth("relay-1", { status: "ready", checkedAt: Date.now() })
    const applied = await state.setHealth("relay-1", { status: "unreachable" })

    expect(applied).toBe(true)
    expect(state.exit("relay-1")?.status).toBe("unreachable")
  })
})

describe("the response and retry hooks on a 409", () => {
  test("a bare 409 records the failure and is not retried", async () => {
    const { state, hooks } = await makeHooks()
    await state.addRelay(relay("relay-1"))
    await state.addRelay(relay("relay-2"))
    await state.setHealth("relay-1", { status: "ready" })
    await state.setHealth("relay-2", { status: "ready" })
    state.noteRelayed("session-1", "iceman-free", "relay-1")

    await hooks.get("http.response")?.(responseInput("session-1", "relay-1", 409) as never)

    expect(state.statsFor("relay-1").failed).toBe(1)
    expect(state.exit("relay-1")?.status).toBe("bad")
    expect(state.summaryOf("relay-1")?.lastError).toContain("409")
    expect(state.coolingExits()).toContain("relay-1")
    expect(state.failureFor("session-1", "iceman-free")?.kind).toBe("server")
    // The exit is resting, but another one could serve: a bare 409 still must
    // not send the same request there.
    expect(state.pickExit({ advance: false }).exit?.id).toBe("relay-2")

    const retry = {
      sessionID: "session-1",
      model: { id: "iceman-free", providerID: "opencode" },
      error: { status: 409 },
      attempt: 1,
      decision: { retry: false } as { retry: boolean; delay?: number },
    }
    await hooks.get("retry")?.(retry as never)

    expect(retry.decision).toEqual({ retry: false })
  })

  test("the exhausted strategy keeps the chosen exit through a short rest", async () => {
    const { state } = await makeRestartable()
    await state.addRelay(relay("relay-a"))
    await state.addRelay(relay("relay-b"))
    await state.setHealth("relay-a", { status: "ready" })
    await state.setHealth("relay-b", { status: "ready" })
    await state.setActiveExit("relay-a")
    await state.setStrategy("exhausted")

    // A failure rests the chosen exit for a while. The backup takes the
    // request meanwhile, but the choice is not the user's to lose.
    state.markFailure("relay-a", "The exit did not answer.", "unreachable")
    expect(state.pickExit({ advance: true }).exit?.id).toBe("relay-b")
    expect(state.settings().activeExitId).toBe("relay-a")

    // When the rest is over, the chosen exit serves again.
    const later = state.pickExit({ advance: true, now: Date.now() + 10 * 60_000 }).exit?.id
    expect(later).toBe("relay-a")
    expect(state.settings().activeExitId).toBe("relay-a")
  })

  test("a used-up exit does change the choice, because that is the strategy", async () => {
    const { state } = await makeRestartable()
    await state.addRelay(relay("relay-a"))
    await state.addRelay(relay("relay-b"))
    await state.setHealth("relay-a", { status: "ready" })
    await state.setHealth("relay-b", { status: "ready" })
    await state.setActiveExit("relay-a")
    await state.setStrategy("exhausted")

    state.markExhausted("relay-a", Date.now() + 60 * 60_000, "The allowance is gone.")
    // The choice moves through the rules writer, so give the queued write the
    // tick it needs before reading the rules back.
    await Bun.sleep(0)

    expect(state.settings().activeExitId).toBe("relay-b")
  })

  test("bring used-up exits back forgives their addresses", async () => {
    const { state, hooks } = await makeHooks()
    await state.addRelay(relay("relay-1"))
    await state.setHealth("relay-1", { status: "ready" })
    state.noteRelayed("session-restore", "iceman-free", "relay-1")

    // The exit is used up, and its address is remembered as spent: a restore
    // that left the address alone would be refused again at once by the
    // relay's own avoid echo.
    const until = Date.now() + 60 * 60_000
    await state.setHealth("relay-1", { status: "exhausted", exhaustedUntil: until })
    state.markSpent("203.0.113.20", until)
    state.noteEgress("relay-1", "203.0.113.20")

    const { restored } = await state.restoreExhausted(() => true)

    expect(restored).toEqual(["relay-1"])
    expect(state.exit("relay-1")?.status).toBe("reachable")
    // The address is forgiven: it is no longer in the avoid list, so the
    // relay's own echo cannot retire the exit again at once.
    expect(state.isSpent("203.0.113.20")).toBe(false)
  })

  test("bring used-up exits back leaves a live window alone when not forgiven", async () => {
    const { state } = await makeHooks()
    await state.addRelay(relay("relay-1"))
    await state.setHealth("relay-1", { status: "ready" })

    const until = Date.now() + 60 * 60_000
    await state.setHealth("relay-1", { status: "exhausted", exhaustedUntil: until })
    state.noteEgress("relay-1", "203.0.113.21")
    state.markSpent("203.0.113.21", until)

    // Without the forgiveness decision, a restore cannot make the exit
    // serve: the provider's window is live, and the exit would be refused
    // again on its first request.
    const { restored, stillUsedUp } = await state.restoreExhausted()

    expect(restored).toEqual([])
    expect(stillUsedUp).toEqual(["relay-1"])
    expect(state.exit("relay-1")?.status).toBe("exhausted")
    expect(state.isSpent("203.0.113.21")).toBe(true)
  })

  test("a rotate 409 with a spent address retires the exit, and asks for another attempt", async () => {
    const { state, hooks } = await makeHooks()
    await state.addRelay(relay("relay-1"))
    await state.addRelay(relay("relay-2"))
    await state.setHealth("relay-1", { status: "ready" })
    await state.setHealth("relay-2", { status: "ready" })
    state.noteRelayed("session-2", "iceman-free", "relay-1")
    // The avoid list the relay echoes back is built from the live spent
    // entries, so the address is spent before the echo arrives: the window
    // the provider gave is what the exit rests for.
    state.markSpent("203.0.113.9", Date.now() + 60 * 60_000)

    await hooks.get("http.response")?.(
      responseInput("session-2", "relay-1", 409, {
        "x-relay-rotate": "1",
        "x-relay-egress": "203.0.113.9",
      }) as never,
    )

    expect(state.exit("relay-1")?.status).toBe("exhausted")
    expect(state.exit("relay-1")?.exhaustedUntil).toBeGreaterThan(Date.now() + 59 * 60_000)
    expect(state.failureFor("session-2", "iceman-free")?.kind).toBe("rotate")
    expect(state.spentEgresses()).toContain("203.0.113.9")

    const retry = {
      sessionID: "session-2",
      model: { id: "iceman-free", providerID: "opencode" },
      error: { status: 409 },
      attempt: 1,
      decision: { retry: false } as { retry: boolean; delay?: number },
    }
    await hooks.get("retry")?.(retry as never)

    expect(retry.decision).toEqual({ retry: true, delay: ROTATE_DELAY_MS })
  })

  test("a rotate 409 with an unknown address is a short rest, not a retirement", async () => {
    const { state, hooks } = await makeHooks()
    await state.addRelay(relay("relay-1"))
    await state.addRelay(relay("relay-2"))
    await state.setHealth("relay-1", { status: "ready" })
    await state.setHealth("relay-2", { status: "ready" })
    state.noteRelayed("session-3", "iceman-free", "relay-1")

    await hooks.get("http.response")?.(
      responseInput("session-3", "relay-1", 409, {
        "x-relay-rotate": "1",
        "x-relay-egress": "203.0.113.9",
      }) as never,
    )

    // The echo names an address that is not spent, so it is a stale echo and
    // not provider evidence: the exit rests instead of retiring until the
    // window would have ended, and the address is not marked spent for longer.
    expect(state.exit("relay-1")?.status).toBe("limited")
    expect(state.exit("relay-1")?.exhaustedUntil).toBeUndefined()
    expect(state.coolingExits()).toContain("relay-1")
    expect(state.spentEgresses()).not.toContain("203.0.113.9")
    expect(state.failureFor("session-3", "iceman-free")?.kind).toBe("rotate")

    const retry = {
      sessionID: "session-3",
      model: { id: "iceman-free", providerID: "opencode" },
      error: { status: 409 },
      attempt: 1,
      decision: { retry: false } as { retry: boolean; delay?: number },
    }
    await hooks.get("retry")?.(retry as never)

    expect(retry.decision).toEqual({ retry: true, delay: ROTATE_DELAY_MS })
  })
})

describe("a write that does not land", () => {
  test("a pause that was not written leaves the exit in use", async () => {
    const storage = failingStorage()
    const state = new RelayState(storage as never)
    await state.load()
    await state.addRelay(relay("relay-1"))
    await state.setHealth("relay-1", { status: "ready" })
    storage.fail("relays")

    await expect(state.setExitEnabled("relay-1", false)).rejects.toThrow(/relays/)

    // The disk still has the exit enabled, so the memory must not call it
    // paused: it would stop serving now and come back at the next restart.
    expect(state.exit("relay-1")?.enabled).toBe(true)
    expect(state.pickExit({ advance: false }).exit?.id).toBe("relay-1")
  })

  test("a verdict that was not written does not undo a live one", async () => {
    const storage = failingStorage()
    const state = new RelayState(storage as never)
    await state.load()
    await state.addRelay(relay("relay-1"))
    await state.setHealth("relay-1", { status: "unreachable" })
    const epochBefore = state.healthEpoch("relay-1")
    // A live failure armed a rest before the failing verdict: it is the rest
    // the rollback would put back over the success.
    state.markFailure("relay-1", "The exit did not answer.", "unreachable")
    await Bun.sleep(0)
    storage.fail("relays")

    // The failing verdict is in flight when a real request proves the exit
    // works. The rollback must not put the stale record back over that answer,
    // and must not rewind the epoch the answer bumped.
    const failing = state.setHealth("relay-1", { status: "bad" })
    state.markSuccess("relay-1", 120)
    const epochAfterLive = state.healthEpoch("relay-1")
    await expect(failing).rejects.toThrow(/relays/)

    expect(state.exit("relay-1")?.status).toBe("ready")
    expect(state.exit("relay-1")?.status).not.toBe("bad")
    expect(state.healthEpoch("relay-1")).toBeGreaterThanOrEqual(epochBefore)
    expect(state.healthEpoch("relay-1")).toBe(epochAfterLive)
    // The rest the failure armed went with the success, and the rollback must
    // not bring the older one back: it would bench an exit that just served.
    expect(state.coolingExits()).not.toContain("relay-1")
    expect(state.pickExit({ advance: false }).exit?.id).toBe("relay-1")
  })

  test("a pause that was not written leaves a live verdict alone", async () => {
    const storage = failingStorage()
    const state = new RelayState(storage as never)
    await state.load()
    await state.addRelay(relay("relay-1"))
    await state.setHealth("relay-1", { status: "ready" })
    storage.fail("relays")

    // The pause is in flight when a real request fails through the exit. The
    // rollback may take back the switch and nothing else: the live failure
    // and the rest it armed are what the next request has to obey, and the
    // old record would show a working exit whose rest only lives in memory.
    const pausing = state.setExitEnabled("relay-1", false)
    state.markFailure("relay-1", "The exit did not answer.", "unreachable")
    await expect(pausing).rejects.toThrow(/relays/)

    expect(state.exit("relay-1")?.enabled).toBe(true)
    expect(state.exit("relay-1")?.status).toBe("unreachable")
    expect(state.exit("relay-1")?.coolingUntil).toBeDefined()
    expect(state.coolingExits()).toContain("relay-1")
  })

  test("a restore that was not written puts the provider's window back", async () => {
    const storage = failingStorage()
    const state = new RelayState(storage as never)
    await state.load()
    await state.addRelay(relay("relay-1"))
    await state.setHealth("relay-1", { status: "ready" })
    // Twenty hours, so a made-up one-hour window cannot pass for it.
    const window = Date.now() + 20 * 60 * 60_000
    state.noteEgress("relay-1", "203.0.113.7")
    state.markSpent("203.0.113.7", window)
    await state.setHealth("relay-1", { status: "exhausted", exhaustedUntil: window })
    storage.fail("relays")

    await expect(state.restoreExhausted(() => true)).rejects.toThrow(/relays/)

    // The exit is used up again, and the address with it: a rollback that
    // forgot the address would send the next request out from the allowance
    // the provider already refused.
    expect(state.exit("relay-1")?.status).toBe("exhausted")
    expect(state.isSpent("203.0.113.7")).toBe(true)
    // The window is the provider's, not one this plugin made up.
    expect(state.spentUntil("203.0.113.7")).toBe(window)
  })

  test("a restore whose proxies could not be written reports only the relays", async () => {
    const storage = failingStorage()
    const state = new RelayState(storage as never)
    await state.load()
    await state.addRelay(relay("relay-1"))
    await state.addProxy(proxy("proxy-1"))
    await state.setHealth("relay-1", { status: "ready" })
    await state.setHealth("proxy-1", { status: "ready" })
    const window = Date.now() + 60 * 60_000
    await state.setHealth("relay-1", {
      status: "exhausted",
      exhaustedUntil: window,
      egress: "203.0.113.10",
    })
    await state.setHealth("proxy-1", {
      status: "exhausted",
      exhaustedUntil: window,
      egress: "203.0.113.11",
    })
    state.markSpent("203.0.113.10", window)
    state.markSpent("203.0.113.11", window)
    // The relays are written; the proxies are not.
    storage.fail("proxies")

    const result = await state.restoreExhausted(() => true)

    // The relay landed, so it is restored. The proxy was rolled back: it is
    // not reported as restored, and is named with the exits still out of use
    // instead — the caller must not toast a restore the next request cannot
    // use.
    expect(result.restored).toEqual(["relay-1"])
    expect(result.stillUsedUp).toEqual(["proxy-1"])
    expect(result.failed?.key).toBe("proxies")
    expect(state.exit("relay-1")?.status).toBe("reachable")
    expect(state.exit("proxy-1")?.status).toBe("exhausted")
    // The proxy's address is spent again: the provider's window is live, and
    // dropping it would send the next request out from the refused allowance.
    expect(state.isSpent("203.0.113.11")).toBe(true)
    expect(state.spentUntil("203.0.113.11")).toBe(window)
    // The relay's write landed, so its address stays forgiven.
    expect(state.isSpent("203.0.113.10")).toBe(false)
  })

  test("a resume that was not written leaves the proxies paused too", async () => {
    const storage = failingStorage()
    const state = new RelayState(storage as never)
    await state.load()
    await state.addRelay(relay("relay-1"))
    await state.addProxy(proxy("proxy-1"))
    await state.setExitEnabled("relay-1", false)
    await state.setExitEnabled("proxy-1", false)
    storage.fail("relays")

    await expect(state.resumeAll()).rejects.toThrow(/relays/)

    expect(state.exit("relay-1")?.enabled).toBe(false)
    // The proxies were put back into use before the relays were written and
    // never reached the disk: a proxy enabled in memory here would serve
    // traffic the next restart takes away.
    expect(state.exit("proxy-1")?.enabled).toBe(false)
  })
})

describe("the picker's reasons", () => {
  test("a used-up exit says so, not why the caller left it out", async () => {
    const state = await readyState(["relay-1", "relay-2"])
    await state.setHealth("relay-1", {
      status: "exhausted",
      exhaustedUntil: Date.now() + 60 * 60_000,
    })
    const exclusion = { id: "relay-1", reason: "the local proxy bridge is not running" }

    const pick = state.pickExit({
      advance: false,
      exclude: [exclusion, { id: "relay-2", reason: exclusion.reason }],
    })

    const spent = pick.skipped.find((exit) => exit.id === "relay-1")
    expect(spent?.reason).toContain("used up")
    // The exclusion names a problem this exit does not have: its allowance is
    // what is gone, and saying otherwise hides the reason behind a stranger's.
    expect(spent?.reason).not.toBe(exclusion.reason)

    // An exit that could serve but was left out still gets the caller's reason.
    const excluded = pick.skipped.find((exit) => exit.id === "relay-2")
    expect(excluded?.reason).toBe(exclusion.reason)
  })
})

describe("a title request beside the agent loop", () => {
  test("a transport failure blames the agent loop's exit, not the title's", async () => {
    const { state, hooks } = await makeRoutedHooks()
    await state.addRelay(relay("relay-a"))
    await state.addRelay(relay("relay-b"))
    await state.setHealth("relay-a", { status: "ready" })
    await state.setHealth("relay-b", { status: "ready" })
    // Round robin, so the two requests really leave through different exits.
    await state.setStrategy("round-robin")

    const primary = routedRequest("primary")
    const title = routedRequest("title")
    await hooks.get("http.request")?.(primary as never)
    await hooks.get("http.request")?.(title as never)

    expect(primary.request.headers.get("x-relay-id")).toBe("relay-a")
    expect(title.request.headers.get("x-relay-id")).toBe("relay-b")

    // The title's answer arrives before the retry does, so its started mark is
    // cleared and the agent loop's request is the only one still waiting. A
    // real answer through the relay carries the exit's own headers.
    await hooks.get("http.response")?.({
      ...responseInput("session-title", "relay-b", 200, {
        "content-type": "application/json",
        "x-relay-egress": "203.0.113.30",
      }),
      kind: "title",
    } as never)

    // The retry hook is not told which request failed, so the agent loop's
    // note has to win: the title's newer note is a different request's, and
    // blaming its exit would retire a healthy one.
    const retry = {
      sessionID: "session-title",
      model: { id: freeModel.id, providerID: "opencode" },
      error: { message: "The connection was refused." },
      attempt: 1,
      decision: { retry: false } as { retry: boolean; delay?: number },
    }
    await hooks.get("retry")?.(retry as never)

    expect(state.exit("relay-a")?.status).toBe("unreachable")
    expect(state.coolingExits()).toContain("relay-a")
    expect(state.exit("relay-b")?.status).toBe("ready")
    expect(state.coolingExits()).not.toContain("relay-b")
  })

  test("a title that answered 400 does not decide which exit a transport failure rests", async () => {
    const { state, hooks } = await makeRoutedHooks()
    await state.addRelay(relay("relay-a"))
    await state.addRelay(relay("relay-b"))
    await state.setHealth("relay-a", { status: "ready" })
    await state.setHealth("relay-b", { status: "ready" })
    // Round robin, so the two requests really leave through different exits.
    await state.setStrategy("round-robin")

    // The title leaves through relay-a and is refused by the request itself
    // (a 400): the exit answered, so relay-a stays ready.
    const title = routedRequest("title")
    await hooks.get("http.request")?.(title as never)
    expect(title.request.headers.get("x-relay-id")).toBe("relay-a")
    await hooks.get("http.response")?.({
      ...responseInput("session-title", "relay-a", 400),
      kind: "title",
    } as never)
    expect(state.exit("relay-a")?.status).toBe("ready")

    // The agent loop leaves through relay-b and dies at the transport: the
    // failure is relay-b's, and only relay-b may rest for it.
    const primary = routedRequest("primary")
    await hooks.get("http.request")?.(primary as never)
    expect(primary.request.headers.get("x-relay-id")).toBe("relay-b")

    const retry = {
      sessionID: "session-title",
      model: { id: freeModel.id, providerID: "opencode" },
      error: { message: "The connection was refused." },
      attempt: 1,
      decision: { retry: false } as { retry: boolean; delay?: number },
    }
    await hooks.get("retry")?.(retry as never)

    expect(state.exit("relay-b")?.status).toBe("unreachable")
    expect(state.coolingExits()).toContain("relay-b")
    // The newer failure of another kind must not point the rest at relay-a:
    // resting it would keep retrying the exit that cannot carry the loop.
    expect(state.exit("relay-a")?.status).toBe("ready")
    expect(state.coolingExits()).not.toContain("relay-a")
    expect(state.pickExit({ advance: false }).exit?.id).toBe("relay-a")
  })
})

