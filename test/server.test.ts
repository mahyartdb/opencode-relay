import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import type { Server } from "node:http"
import { startRelay, startTraceStub, traceUrl } from "../tools/relay-harness.ts"
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
})