import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import type { Server } from "node:http"
import { startRelay, startTraceStub, traceUrl } from "../tools/relay-harness.ts"
import { ROTATE_DELAY_MS } from "../src/server/hooks.ts"
import plugin from "../src/server/index.ts"

/**
 * The server half, tested the way OpenCode drives it.
 *
 * A real relay runs on a local port, so the request hook is not asked whether it
 * would produce the right headers: the rewritten request is actually sent, and
 * the answer has to come back from OpenCode.
 */

// The relay looks up its own egress address over the network before it answers,
// so these tests are slower than a plain unit test.
setDefaultTimeout(60_000)

const ACCESS = "test-access-token"

type Handler = (input: never) => Promise<void> | void

/** A stand-in for the parts of the OpenCode server the plugin uses. */
function makeContext() {
  const store = new Map<string, unknown>()
  const hooks = new Map<string, Handler>()
  const handlers = new Map<string, (input: unknown, context: unknown) => Promise<unknown>>()
  const commands = new Map<string, { readonly name: string; readonly execute: () => Promise<void> }>()
  const emitted: string[] = []

  const storage = {
    get: async (key: string) => store.get(key) as never,
    set: async (key: string, value: unknown) => {
      store.set(key, value)
    },
    remove: async (key: string) => {
      store.delete(key)
    },
    scan: async () => ({ entries: [] }),
  }

  const context = {
    storage,
    model: {
      list: async () => ({
        data: [
          {
            id: "opencode/iceman-free",
            modelID: "iceman-free",
            providerID: "opencode",
            name: "Iceman Free",
            cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
          },
          {
            id: "opencode/gpt-6.1-sol",
            modelID: "gpt-6.1-sol",
            providerID: "opencode",
            name: "GPT 6.1 Sol",
            cost: [{ input: 2, output: 6, cache: { read: 0.2, write: 0 } }],
          },
          {
            id: "anthropic/claude",
            modelID: "claude",
            providerID: "anthropic",
            name: "Claude",
            cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 0 } }],
          },
        ],
      }),
    },
    session: {
      hook: async (name: string, callback: Handler) => {
        hooks.set(name, callback)
        return { dispose: async () => {} }
      },
    },
    command: {
      transform: async (
        callback: (editor: {
          add: (definition: { readonly name: string; readonly execute: () => Promise<void> }) => void
        }) => void,
      ) => {
        callback({
          add: (definition: { readonly name: string; readonly execute: () => Promise<void> }) => {
            commands.set(definition.name, definition)
          },
        })
        return { dispose: async () => {} }
      },
      reload: async () => {},
    },
    rpc: {
      register: async (_definition: unknown, given: Record<string, unknown>) => {
        for (const [name, handler] of Object.entries(given)) {
          handlers.set(name, handler as (input: unknown, context: unknown) => Promise<unknown>)
        }
        return {
          dispose: async () => {},
          events: {
            emit: async (name: string, data: unknown) => {
              emitted.push(`${name}:${JSON.stringify(data)}`)
            },
          },
        }
      },
    },
  }

  const call = (name: string, input?: unknown) => {
    const handler = handlers.get(name)
    if (!handler) throw new Error(`no handler ${name}`)
    return handler(input, { signal: new AbortController().signal, error: () => ({}) })
  }

  return { context, store, hooks, call, emitted, commands }
}

/** The id of the first relay in a status answer. */
function relayId(status: { relays: readonly { id: string }[] }): string {
  const first = status.relays[0]
  if (!first) throw new Error("no relay")
  return first.id
}

/** Whether the provider can be reached at all. */
async function canReach(url: string): Promise<boolean> {
  try {
    const answer = await fetch(url, { signal: AbortSignal.timeout(5000) })
    return answer.status < 500
  } catch {
    return false
  }
}

// One test talks to the real provider, because that is the behaviour under
// test. Everything else must work without a network, so the probe happens
// before the tests are declared: a skip condition is read when a test is
// declared, not when it runs.
const online = await canReach("https://opencode.ai/inference/openai/v1/models")

describe("the server half", () => {
  let server: Server
  let trace: Server
  let url = ""
  beforeAll(async () => {
    // The address lookup is pointed at a local stub, so the tests do not depend
    // on the service the relay normally asks.
    trace = await startTraceStub()
    process.env.RELAY_TRACE_URL = traceUrl(trace)
    process.env.RELAY_TOKEN = ACCESS
    const relay = await startRelay()
    url = relay.url
    server = relay.server
  })

  afterAll(async () => {
    // The relay keeps its connections alive, so they have to go before the server does.
    server?.closeAllConnections()
    server?.close()
    trace?.close()
    delete process.env.RELAY_TRACE_URL
    delete process.env.RELAY_TOKEN
  })

  test("does nothing while it is off", async () => {
    const { context, hooks, call } = makeContext()
    const dispose = await plugin.setup(context as never)

    const status = (await call("status")) as { enabled: boolean; relays: unknown[] }
    expect(status.enabled).toBe(false)
    expect(status.relays).toEqual([])

    const input = {
      model: { id: "iceman-free", providerID: "opencode" },
      request: new Request("https://opencode.ai/inference/openai/v1/models"),
    }
    await hooks.get("http.request")?.(input as never)
    expect(input.request.url).toBe("https://opencode.ai/inference/openai/v1/models")

    await dispose?.()
  })

  test("leaves requests for other providers alone", async () => {
    const { context, hooks, call } = makeContext()
    const dispose = await plugin.setup(context as never)

    await call("addRelay", { name: "local", url, access: ACCESS })
    const status = (await call("status")) as { relays: readonly { id: string }[] }
    await call("useRelay", { id: relayId(status) })
    await call("setEnabled", { enabled: true })
    await call("setSelection", { selection: "all" })

    const input = {
      model: { id: "claude", providerID: "anthropic" },
      request: new Request("https://api.anthropic.com/v1/messages"),
    }
    await hooks.get("http.request")?.(input as never)
    expect(input.request.url).toBe("https://api.anthropic.com/v1/messages")

    await dispose?.()
  })

  test("a spent address is answered with a real rotate header", async () => {
    const { context, hooks, call } = makeContext()
    const dispose = await plugin.setup(context as never)

    await call("addRelay", { name: "local", url, access: ACCESS })
    const status = (await call("status")) as { relays: readonly { id: string }[] }
    await call("useRelay", { id: relayId(status) })
    await call("setEnabled", { enabled: true })
    await call("setSelection", { selection: "all" })

    // Ask the relay which address it uses, then ask it to avoid that very address.
    const ping = await fetch(url, { headers: { "x-relay-key": ACCESS, "x-relay-control": "ping" } })
    const used = (await ping.json()) as { egress?: string }
    expect(used.egress).toBeTruthy()

    const answer = await fetch(url, {
      headers: {
        "x-relay-key": ACCESS,
        "x-relay-target": "https://opencode.ai",
        "x-relay-path": "/inference/openai/v1/models",
        "x-relay-avoid": used.egress ?? "",
      },
    })
    expect(answer.status).toBe(409)
    // The client reads the rotate flag from the headers, so it has to be there.
    expect(answer.headers.get("x-relay-rotate")).toBe("1")
    expect(answer.headers.get("x-relay-egress")).toBe(used.egress ?? null)

    await dispose?.()
  })

  test.skipIf(!online)("routes a selected model through the relay, and the answer comes back", async () => {
    const { context, hooks, call } = makeContext()
    const dispose = await plugin.setup(context as never)

    await call("addRelay", { name: "local", url, access: ACCESS })
    const status = (await call("status")) as { relays: readonly { id: string }[] }
    await call("useRelay", { id: relayId(status) })
    await call("setEnabled", { enabled: true })
    await call("setSelection", { selection: "free" })

    const input = {
      model: { id: "iceman-free", providerID: "opencode" },
      request: new Request("https://opencode.ai/inference/openai/v1/models"),
    }
    await hooks.get("http.request")?.(input as never)

    // The request now points at the relay and carries the relay's headers.
    expect(input.request.url).toBe(`${url}/`)
    expect(input.request.headers.get("x-relay-target")).toBe("https://opencode.ai")
    expect(input.request.headers.get("x-relay-path")).toBe("/inference/openai/v1/models")
    expect(input.request.headers.get("x-relay-key")).toBe(ACCESS)

    // And it really works: the relay calls OpenCode and the answer comes back.
    const answer = await fetch(input.request)
    expect(answer.status).toBe(200)
    const body = (await answer.json()) as { data: { id: string }[] }
    expect(body.data.length).toBeGreaterThan(0)
    // The runtime is always reported. The egress address is only reported when the
    // relay could look it up, which depends on a third party answering.
    expect(answer.headers.get("x-relay-runtime")).toBeTruthy()

    await dispose?.()
  })

  test("a paid model stays direct when only the free ones are routed", async () => {
    const { context, hooks, call } = makeContext()
    const dispose = await plugin.setup(context as never)

    await call("addRelay", { name: "local", url, access: ACCESS })
    const status = (await call("status")) as { relays: readonly { id: string }[] }
    await call("useRelay", { id: relayId(status) })
    await call("setEnabled", { enabled: true })
    await call("setSelection", { selection: "free" })

    const input = {
      model: { id: "gpt-6.1-sol", providerID: "opencode" },
      request: new Request("https://opencode.ai/inference/openai/v1/models"),
    }
    await hooks.get("http.request")?.(input as never)
    expect(input.request.url).toBe("https://opencode.ai/inference/openai/v1/models")

    await dispose?.()
  })

  test("remembers the relays, the accounts and the rules across a restart", async () => {
    const { context, store, call } = makeContext()
    const dispose = await plugin.setup(context as never)

    await call("addRelay", { name: "local", url, access: ACCESS })
    const status = (await call("status")) as { relays: readonly { id: string }[] }
    await call("useRelay", { id: relayId(status) })
    await call("setEnabled", { enabled: true })
    await call("setSelection", { selection: "custom", models: ["iceman-free"] })
    await dispose?.()

    // A second run finds the same relay and the same rules.
    const again = makeContext()
    for (const [key, value] of store) again.store.set(key, value)
    const dispose2 = await plugin.setup(again.context as never)
    const restored = (await again.call("status")) as {
      enabled: boolean
      selection: string
      customModels: string[]
      activeRelay?: { name: string }
    }
    expect(restored.enabled).toBe(true)
    expect(restored.selection).toBe("custom")
    expect(restored.customModels).toEqual(["iceman-free"])
    expect(restored.activeRelay?.name).toBe("local")
    await dispose2?.()
  })

  test("a relay that is gone stops being the active one", async () => {
    const { context, call } = makeContext()
    const dispose = await plugin.setup(context as never)

    await call("addRelay", { name: "local", url, access: ACCESS })
    const status = (await call("status")) as { relays: readonly { id: string }[] }
    await call("useRelay", { id: relayId(status) })
    await call("setEnabled", { enabled: true })

    const removed = (await call("removeRelay", { id: relayId(status) })) as { removed: boolean }
    expect(removed.removed).toBe(true)

    const after = (await call("status")) as { activeRelay?: unknown; note: string }
    expect(after.activeRelay).toBeUndefined()
    expect(after.note).toContain("no relay")

    await dispose?.()
  })

  test("the access token never leaves the server", async () => {
    const { context, call } = makeContext()
    const dispose = await plugin.setup(context as never)

    await call("addRelay", { name: "local", url, access: ACCESS })
    const status = JSON.stringify(await call("status"))
    expect(status).not.toContain(ACCESS)
    expect(status).not.toContain("access")

    await dispose?.()
  })

  test("offers the command in the prompt", async () => {
    const { context, commands, emitted } = makeContext()
    const dispose = await plugin.setup(context as never)

    // The prompt offers the commands the server knows about, so this is where
    // the command has to be, or /relay is nowhere to be found.
    const command = commands.get("relay")
    expect(command).toBeDefined()

    // Running it asks the terminal part to open its menu: the server cannot
    // open a dialog itself.
    await command?.execute()
    expect(emitted.some((entry) => entry.startsWith("menu:"))).toBe(true)

    await dispose?.()
  })

  test("announces every change", async () => {
    const { context, call, emitted } = makeContext()
    const dispose = await plugin.setup(context as never)

    await call("setEnabled", { enabled: true })
    expect(emitted.some((entry) => entry.includes("routing enabled"))).toBe(true)

    await dispose?.()
  })

  test("the first relay becomes the chosen one", async () => {
    const { context, call } = makeContext()
    const dispose = await plugin.setup(context as never)

    const added = (await call("addRelay", { name: "local", url, access: ACCESS })) as { id: string }
    const status = (await call("status")) as { activeRelay?: { id: string } }
    expect(status.activeRelay?.id).toBe(added.id)

    await dispose?.()
  })

  test("remembers the strategy across a restart", async () => {
    const { context, store, call } = makeContext()
    const dispose = await plugin.setup(context as never)
    await call("setStrategy", { strategy: "round-robin" })
    const status = (await call("status")) as { strategy: string }
    expect(status.strategy).toBe("round-robin")
    await dispose?.()

    const again = makeContext()
    for (const [key, value] of store) again.store.set(key, value)
    const dispose2 = await plugin.setup(again.context as never)
    const restored = (await again.call("status")) as { strategy: string }
    expect(restored.strategy).toBe("round-robin")
    await dispose2?.()
  })

  test("an installation from before the strategies keeps its rules", async () => {
    const { context, store, call } = makeContext()
    const dispose = await plugin.setup(context as never)
    await call("addRelay", { name: "local", url, access: ACCESS })
    await call("setEnabled", { enabled: true })
    await call("setSelection", { selection: "custom", models: ["iceman-free"] })
    await dispose?.()

    // The strategy was added later, so an older stored value has no such key.
    const settings = store.get("settings") as Record<string, unknown>
    delete settings.strategy

    const again = makeContext()
    for (const [key, value] of store) again.store.set(key, value)
    const dispose2 = await plugin.setup(again.context as never)
    const status = (await again.call("status")) as {
      enabled: boolean
      selection: string
      strategy: string
      customModels: string[]
    }
    expect(status.enabled).toBe(true)
    expect(status.selection).toBe("custom")
    expect(status.customModels).toEqual(["iceman-free"])
    expect(status.strategy).toBe("fixed")
    await dispose2?.()
  })

  test("a stored choice that points at nothing falls back to the first relay", async () => {
    const { context, store, call } = makeContext()
    const dispose = await plugin.setup(context as never)
    const added = (await call("addRelay", { name: "local", url, access: ACCESS })) as { id: string }
    await dispose?.()

    const settings = store.get("settings") as Record<string, unknown>
    settings.activeRelayId = "relay-that-is-gone"

    const again = makeContext()
    for (const [key, value] of store) again.store.set(key, value)
    const dispose2 = await plugin.setup(again.context as never)
    const status = (await again.call("status")) as { activeRelay?: { id: string } }
    expect(status.activeRelay?.id).toBe(added.id)
    await dispose2?.()
  })

  test("round robin spreads requests and sidelines a relay that is used up", async () => {
    const { context, hooks, call } = makeContext()
    const dispose = await plugin.setup(context as never)

    await call("addRelay", { name: "one", url, access: ACCESS })
    await call("addRelay", { name: "two", url, access: ACCESS })
    const status = (await call("status")) as { relays: readonly { id: string; name: string }[] }
    const first = status.relays[0]
    const second = status.relays[1]
    if (!first || !second) throw new Error("the relays were not stored")

    await call("setEnabled", { enabled: true })
    await call("setSelection", { selection: "all" })
    await call("setStrategy", { strategy: "round-robin" })

    const send = async () => {
      const input = {
        model: { id: "iceman-free", providerID: "opencode" },
        request: new Request("https://opencode.ai/inference/openai/v1/models"),
      }
      await hooks.get("http.request")?.(input as never)
      return input.request
    }

    const one = await send()
    const two = await send()
    expect(one.headers.get("x-relay-id")).toBe(first.id)
    expect(two.headers.get("x-relay-id")).toBe(second.id)

    // The second relay answers 429, so it is the one that is used up, even
    // though the first relay is the one the user chose.
    const answer = new Response("free usage limit", {
      status: 429,
      headers: { "x-relay-egress": "9.9.9.9" },
    })
    await hooks.get("http.response")?.({
      model: { id: "iceman-free", providerID: "opencode" },
      request: two,
      response: answer,
    } as never)
    const after = (await call("status")) as { exhausted: string[] }
    expect(after.exhausted).toEqual([second.id])

    // The next request skips the exhausted relay and lands on the first one.
    const three = await send()
    expect(three.headers.get("x-relay-id")).toBe(first.id)
    expect(three.headers.get("x-relay-avoid")).toBeNull()

    // Bringing it back makes it usable again, and its spent address is still
    // avoided, because that is a fact about the address and not about the relay.
    const restored = (await call("resetExhausted")) as { restored: string[] }
    expect(restored.restored).toEqual([second.id])
    // The rotation starts over, so the first request goes to the first relay
    // and the next one reaches the relay that was just brought back.
    const four = await send()
    expect(four.headers.get("x-relay-id")).toBe(first.id)
    const five = await send()
    expect(five.headers.get("x-relay-id")).toBe(second.id)
    expect(five.headers.get("x-relay-avoid")).toBe("9.9.9.9")
    const clean = (await call("status")) as { exhausted: string[] }
    expect(clean.exhausted).toEqual([])

    await dispose?.()
  })

  test("removing the chosen relay hands the choice to the next one", async () => {
    const { context, call } = makeContext()
    const dispose = await plugin.setup(context as never)

    const one = (await call("addRelay", { name: "one", url, access: ACCESS })) as { id: string }
    const two = (await call("addRelay", { name: "two", url, access: ACCESS })) as { id: string }
    await call("useRelay", { id: one.id })
    const removed = (await call("removeRelay", { id: one.id, deleteProject: false })) as {
      removed: boolean
      projectDeleted: boolean
    }
    expect(removed).toEqual({ removed: true, projectDeleted: false })

    const status = (await call("status")) as { activeRelay?: { id: string } }
    expect(status.activeRelay?.id).toBe(two.id)

    await dispose?.()
  })

  test("a used-up answer is retried on the one-relay strategy too", async () => {
    const { context, hooks, call } = makeContext()
    const dispose = await plugin.setup(context as never)

    const only = (await call("addRelay", { name: "only", url, access: ACCESS })) as { id: string }
    await call("useRelay", { id: only.id })
    await call("setEnabled", { enabled: true })
    await call("setSelection", { selection: "all" })
    expect(((await call("status")) as { strategy: string }).strategy).toBe("fixed")

    const request = {
      sessionID: "session-fixed",
      model: { id: "iceman-free", providerID: "opencode" },
      request: new Request("https://opencode.ai/inference/openai/v1/models"),
    }
    await hooks.get("http.request")?.(request as never)
    expect(request.request.headers.get("x-relay-id")).toBe(only.id)

    const limited: {
      sessionID: string
      model: { id: string }
      error: { status: number; response: { body: string } }
      attempt: number
      decision: { retry: boolean; delay?: number }
    } = {
      sessionID: "session-fixed",
      model: { id: "iceman-free" },
      error: { status: 429, response: { body: '{"error":{"message":"Free usage limit reached"}}' } },
      attempt: 1,
      decision: { retry: false },
    }
    await hooks.get("retry")?.(limited as never)
    expect(limited.decision).toEqual({ retry: true, delay: ROTATE_DELAY_MS })

    await dispose?.()
  })

  test("asks for another attempt when the instance behind the relay is used up", async () => {
    const { context, hooks, call } = makeContext()
    const dispose = await plugin.setup(context as never)
    const retry = hooks.get("retry")

    // Only a request this plugin routed can be blamed on a relay.
    const directRotation = {
      sessionID: "session-direct",
      model: { id: "iceman-free" },
      error: { status: 409 },
      attempt: 1,
      decision: { retry: false },
    }
    await retry?.(directRotation as never)
    expect(directRotation.decision).toEqual({ retry: false })

    await call("addRelay", { name: "local", url, access: ACCESS })
    await call("setEnabled", { enabled: true })
    await call("setSelection", { selection: "all" })
    const request = {
      sessionID: "session-1",
      model: { id: "iceman-free", providerID: "opencode" },
      request: new Request("https://opencode.ai/inference/openai/v1/models"),
    }
    await hooks.get("http.request")?.(request as never)

    // The instance behind the relay is used up, so another attempt is asked
    // for, and the attempt count is not allowed to grow without end.
    const first: {
      sessionID: string
      model: { id: string }
      error: { status: number }
      attempt: number
      decision: { retry: boolean; delay?: number }
    } = {
      sessionID: "session-1",
      model: { id: "iceman-free" },
      error: { status: 409 },
      attempt: 1,
      decision: { retry: false },
    }
    await retry?.(first as never)
    expect(first.decision).toEqual({ retry: true, delay: ROTATE_DELAY_MS })

    const last = {
      sessionID: "session-1",
      model: { id: "iceman-free" },
      error: { status: 409 },
      attempt: 9,
      decision: { retry: false },
    }
    await retry?.(last as never)
    expect(last.decision).toEqual({ retry: false })

    const limited: {
      sessionID: string
      model: { id: string }
      error: { status: number; response: { body: string } }
      attempt: number
      decision: { retry: boolean; delay?: number }
    } = {
      sessionID: "session-1",
      model: { id: "iceman-free" },
      error: { status: 429, response: { body: '{"error":{"message":"Free usage limit reached"}}' } },
      attempt: 1,
      decision: { retry: false },
    }
    await retry?.(limited as never)
    expect(limited.decision).toEqual({ retry: true, delay: ROTATE_DELAY_MS })

    // The same answer for a request that never went through a relay is not the
    // relay's fault, so nothing is retried.
    const direct = {
      sessionID: "session-2",
      model: { id: "gpt-6.1-sol" },
      error: { status: 429, response: { body: '{"error":{"message":"Free usage limit reached"}}' } },
      attempt: 1,
      decision: { retry: false },
    }
    await retry?.(direct as never)
    expect(direct.decision).toEqual({ retry: false })

    await dispose?.()
  })

  test("never routes through a relay that did not answer", async () => {
    const { context, hooks, call } = makeContext()
    const dispose = await plugin.setup(context as never)

    // Port 9 is the discard port: nothing listens there, so the check fails.
    const dead = (await call("addRelay", {
      name: "dead end",
      url: "http://127.0.0.1:9",
      access: ACCESS,
    })) as { id: string; reachable: boolean }
    expect(dead.reachable).toBe(false)
    await call("useRelay", { id: dead.id })
    await call("setEnabled", { enabled: true })
    await call("setSelection", { selection: "all" })

    const input = {
      sessionID: "session-dead",
      model: { id: "iceman-free", providerID: "opencode" },
      request: new Request("https://opencode.ai/inference/openai/v1/models"),
    }
    await hooks.get("http.request")?.(input as never)
    // The session keeps working: the request goes where it would have gone
    // without the plugin, rather than to a relay that cannot answer.
    expect(input.request.url).toBe("https://opencode.ai/inference/openai/v1/models")

    const status = (await call("status")) as { skipped: readonly string[]; note?: string }
    expect(status.skipped).toContain(dead.id)
    expect(status.note).toContain("dead end did not answer")

    await dispose?.()
  })

  test("a relay that cannot be reached is skipped after one failed request", async () => {
    const { context, hooks, call } = makeContext()
    const dispose = await plugin.setup(context as never)

    await call("addRelay", { name: "local", url, access: ACCESS })
    const status = (await call("status")) as { relays: readonly { id: string }[] }
    const id = relayId(status)
    await call("useRelay", { id })
    await call("setEnabled", { enabled: true })
    await call("setSelection", { selection: "all" })

    const first = {
      sessionID: "session-1",
      model: { id: "iceman-free", providerID: "opencode" },
      request: new Request("https://opencode.ai/inference/openai/v1/models"),
    }
    await hooks.get("http.request")?.(first as never)
    expect(first.request.url).toContain(url)

    // A failure with no status never reached the relay. Another attempt is
    // asked for, and the relay is left alone for a while.
    const retryInput: {
      sessionID: string
      model: { id: string }
      error: { status?: number; message: string }
      attempt: number
      decision: { retry: boolean; delay?: number }
    } = {
      sessionID: "session-1",
      model: { id: "iceman-free" },
      error: { message: "fetch failed" },
      attempt: 1,
      decision: { retry: false },
    }
    await hooks.get("retry")?.(retryInput as never)
    expect(retryInput.decision).toEqual({ retry: true, delay: ROTATE_DELAY_MS })

    const second = {
      sessionID: "session-1",
      model: { id: "iceman-free", providerID: "opencode" },
      request: new Request("https://opencode.ai/inference/openai/v1/models"),
    }
    await hooks.get("http.request")?.(second as never)
    expect(second.request.url).toBe("https://opencode.ai/inference/openai/v1/models")

    const after = (await call("status")) as { skipped: readonly string[] }
    expect(after.skipped).toContain(id)

    await dispose?.()
  })

  test("a relay that answers with a server error is skipped too", async () => {
    const { context, hooks, call } = makeContext()
    const dispose = await plugin.setup(context as never)

    await call("addRelay", { name: "local", url, access: ACCESS })
    const status = (await call("status")) as { relays: readonly { id: string }[] }
    const id = relayId(status)
    await call("useRelay", { id })
    await call("setEnabled", { enabled: true })
    await call("setSelection", { selection: "all" })

    const input = {
      sessionID: "session-1",
      model: { id: "iceman-free", providerID: "opencode" },
      request: new Request("https://opencode.ai/inference/openai/v1/models"),
    }
    await hooks.get("http.request")?.(input as never)

    const retryInput: {
      sessionID: string
      model: { id: string }
      error: { status: number; message: string }
      attempt: number
      decision: { retry: boolean; delay?: number }
    } = {
      sessionID: "session-1",
      model: { id: "iceman-free" },
      error: { status: 502, message: "Upstream request failed" },
      attempt: 1,
      decision: { retry: false },
    }
    await hooks.get("retry")?.(retryInput as never)
    expect(retryInput.decision).toEqual({ retry: true, delay: ROTATE_DELAY_MS })

    const after = (await call("status")) as { skipped: readonly string[] }
    expect(after.skipped).toContain(id)

    await dispose?.()
  })

  test("a test of a relay says whether it answered and how fast", async () => {
    const { context, call } = makeContext()
    const dispose = await plugin.setup(context as never)

    const added = (await call("addRelay", { name: "local", url, access: ACCESS })) as { id: string }
    const result = (await call("testRelay", { id: added.id })) as {
      reachable: boolean
      status: number
      ms: number
    }
    expect(result.reachable).toBe(true)
    expect(result.status).toBe(200)
    expect(result.ms).toBeGreaterThanOrEqual(0)

    await dispose?.()
  })
})