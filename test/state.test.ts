import { describe, expect, test } from "bun:test"
import { relayRequest } from "../src/lib/routing.ts"
import type { RelayRecord } from "../src/lib/types.ts"
import { registerHooks, ROTATE_DELAY_MS } from "../src/server/hooks.ts"
import { RelayState, COOLDOWN_BASE_MS } from "../src/server/state.ts"

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
  })
  return { state, hooks: made.hooks }
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
    expect(state.wasRelayed("session-1", "iceman-free")).toBe(true)
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

  test("a rotate 409 still retires the exit and asks for another attempt", async () => {
    const { state, hooks } = await makeHooks()
    await state.addRelay(relay("relay-1"))
    await state.addRelay(relay("relay-2"))
    await state.setHealth("relay-1", { status: "ready" })
    await state.setHealth("relay-2", { status: "ready" })
    state.noteRelayed("session-2", "iceman-free", "relay-1")

    await hooks.get("http.response")?.(
      responseInput("session-2", "relay-1", 409, {
        "x-relay-rotate": "1",
        "x-relay-egress": "203.0.113.9",
      }) as never,
    )

    expect(state.exit("relay-1")?.status).toBe("exhausted")
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
})
