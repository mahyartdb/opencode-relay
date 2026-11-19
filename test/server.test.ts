import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { startRelay, startTraceStub, traceUrl } from "../tools/relay-harness.ts"
import { ROTATE_DELAY_MS } from "../src/server/hooks.ts"
import { relayRequest } from "../src/lib/routing.ts"
import { createHandlers } from "../src/server/handlers.ts"
import { RelayState } from "../src/server/state.ts"
import { Tester } from "../src/server/tester.ts"
import plugin from "../src/server/index.ts"

/**
 * The server half, tested the way OpenCode drives it.
 *
 * A real relay runs on a local port, so the request hook is not asked whether it
 * would produce the right headers: the rewritten request is actually sent, and
 * the answer has to come back from OpenCode.
 *
 * The tests never turn routing on in the live OpenCode service: every test
 * builds its own context, its own storage and its own plugin instance.
 */

// The relay looks up its own egress address over the network before it answers,
// so these tests are slower than a plain unit test.
setDefaultTimeout(60_000)

const ACCESS = "test-access-token"

type Handler = (input: any) => Promise<void> | void

/** The options OpenCode 2.2.7 accepts when a session hook is registered. */
type HookOptions = { readonly providerID?: string }

type Registration = { callback: Handler; options?: HookOptions }

interface StatusAnswer {
  readonly enabled: boolean
  readonly selection: string
  readonly strategy: string
  readonly direct: string
  readonly healthChecks: boolean
  readonly customModels: readonly string[]
  readonly activeExit?: { readonly id: string; readonly name: string; readonly kind: string }
  readonly exits: readonly {
    readonly id: string
    readonly name: string
    readonly kind: "relay" | "proxy"
    readonly status: string
    readonly enabled: boolean
    readonly url: string
    readonly project?: string
    readonly accountId?: string
    readonly statusLabel: string
    readonly lastError?: string
    readonly imported?: boolean
    readonly stats: { readonly requests: number }
  }[]
  readonly exhausted: readonly string[]
  readonly paused: readonly string[]
  readonly skipped: readonly string[]
  /** The exit the picker would use for the next request, when one can serve. */
  readonly servingExitId?: string
  /** Exits the picker would leave out, with its live cooldown state applied. */
  readonly skippedExitIds?: readonly string[]
  readonly note: string
  readonly routedCount: number
  readonly modelCount: number
  readonly scanning?: { readonly total: number; readonly done: number }
  readonly lastDecision?: {
    readonly modelId: string
    readonly routed: boolean
    readonly reason: string
    readonly exitId?: string
  }
}

/** A stand-in for the parts of the OpenCode server the plugin uses. */
function makeContext(models = true, failWrites: readonly string[] = []) {
  const store = new Map<string, unknown>()
  const registrations = new Map<string, Registration[]>()
  const handlers = new Map<string, (input: unknown, context: unknown) => Promise<unknown>>()
  const commands = new Map<string, { readonly name: string; readonly execute: () => Promise<void> }>()
  const emitted: string[] = []

  const storage = {
    get: async (key: string) => store.get(key) as never,
    set: async (key: string, value: unknown) => {
      // A key that cannot be written stands in for a full disk.
      if (failWrites.includes(key)) throw new Error(`ENOSPC: no space left on device (${key})`)
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
      list: async () => {
        if (!models) throw new Error("the model list is unavailable")
        return {
          data: [
            {
              id: "iceman-free",
              modelID: "iceman-free",
              providerID: "opencode",
              name: "Iceman Free",
              cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
            },
            {
              id: "gpt-6.1-sol",
              modelID: "gpt-6.1-sol",
              providerID: "opencode",
              name: "GPT 6.1 Sol",
              cost: [{ input: 2, output: 6, cache: { read: 0.2, write: 0 } }],
            },
            {
              id: "claude",
              modelID: "claude",
              providerID: "anthropic",
              name: "Claude",
              cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 0 } }],
            },
          ],
        }
      },
    },
    session: {
      hook: async (name: string, callback: Handler, options?: HookOptions) => {
        const list = registrations.get(name) ?? []
        list.push({ callback, options })
        registrations.set(name, list)
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
    return handler(input, {
      signal: new AbortController().signal,
      error: (tag: string, message: string, data: unknown) => ({ tag, message, data }),
    })
  }

  // The facade mimics how OpenCode 2.2.7 triggers a registered hook: the
  // registrations of a name run in order, a registration scoped to a provider
  // only fires for that provider's requests, and the comparison is exact.
  const hooks = {
    get(name: string) {
      const list = registrations.get(name) ?? []
      return async (input: any) => {
        for (const registration of list) {
          const scope = registration.options?.providerID
          if (scope !== undefined && input?.model?.providerID !== scope) continue
          return registration.callback(input)
        }
      }
    },
  }

  return { context, store, hooks, registrations, call, emitted, commands }
}

type App = ReturnType<typeof makeContext> & { readonly dispose: () => Promise<void> }

/** Build a plugin instance on its own storage and take it down afterwards. */
async function start(
  models = true,
  store?: Map<string, unknown>,
  failWrites: readonly string[] = [],
): Promise<App> {
  const made = makeContext(models, failWrites)
  if (store) for (const [key, value] of store) made.store.set(key, value)
  const dispose = await plugin.setup(made.context as never)
  return { ...made, dispose: async () => { await dispose?.() } }
}

/** The id of the first exit in a status answer. */
function firstExit(status: StatusAnswer): StatusAnswer["exits"][number] {
  const exit = status.exits[0]
  if (!exit) throw new Error("no exit")
  return exit
}

/** A relay as storage holds it, so a status test can choose its health exactly. */
function storedRelay(
  id: string,
  name: string,
  status: "untested" | "reachable" | "unreachable",
): Record<string, unknown> {
  return {
    kind: "relay",
    id,
    name,
    project: "",
    region: "",
    url: "http://127.0.0.1:9",
    access: ACCESS,
    accountId: "",
    enabled: true,
    status,
    createdAt: Date.now(),
  }
}

/**
 * Routing rules that start off, so the plugin does not scan untested exits on
 * startup before the test asks for its first status.
 */
function storedSettings(activeExitId: string): Record<string, unknown> {
  return {
    enabled: false,
    selection: "free",
    strategy: "fixed",
    customModels: [],
    direct: "allow",
    healthChecks: true,
    activeExitId,
  }
}

/** How long to wait before asking again, so a failed probe is retried, not trusted. */
const PROBE_RETRY_MS = 500

/**
 * Whether the provider can be reached at all.
 *
 * The probe keeps asking until the api check's own budget runs out. A one-shot
 * attempt shorter than the check says "no network" under load while the check
 * itself still succeeds a moment later, and the test then asserts the wrong
 * branch of its answer.
 */
async function canReach(url: string): Promise<boolean> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const left = deadline - Date.now()
    if (left <= 0) return false
    try {
      const answer = await fetch(url, { signal: AbortSignal.timeout(left) })
      if (answer.status === 200) return true
    } catch {
      // A failed probe only means "ask again", while the budget lasts.
    }
    const wait = Math.min(PROBE_RETRY_MS, deadline - Date.now())
    if (wait > 0) await Bun.sleep(wait)
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

  test("registers every session hook for the opencode provider", async () => {
    const app = await start()
    try {
      expect(app.registrations.get("http.request")?.[0]?.options).toEqual({ providerID: "opencode" })
      expect(app.registrations.get("http.response")?.[0]?.options).toEqual({
        providerID: "opencode",
      })
      expect(app.registrations.get("retry")?.[0]?.options).toEqual({ providerID: "opencode" })
    } finally {
      await app.dispose()
    }
  })

  test("starts off and leaves requests alone", async () => {
    const app = await start()
    try {
      const status = (await app.call("status")) as StatusAnswer
      expect(status.enabled).toBe(false)
      expect(status.exits).toEqual([])
      expect(status.selection).toBe("free")
      expect(status.direct).toBe("allow")
      expect(status.healthChecks).toBe(true)

      const input = {
        sessionID: "off",
        model: { id: "iceman-free", providerID: "opencode" },
        request: new Request("https://opencode.ai/inference/openai/v1/models"),
      }
      await app.hooks.get("http.request")?.(input as never)
      expect(input.request.url).toBe("https://opencode.ai/inference/openai/v1/models")
    } finally {
      await app.dispose()
    }
  })

  test("leaves requests for other providers alone", async () => {
    const app = await start()
    try {
      await app.call("addRelay", { name: "local", url, access: ACCESS })
      const status = (await app.call("status")) as StatusAnswer
      await app.call("useExit", { id: firstExit(status).id })
      await app.call("setEnabled", { enabled: true })

      const enabled = (await app.call("status")) as StatusAnswer
      expect(enabled.enabled).toBe(true)

      const input = {
        sessionID: "other",
        model: { id: "claude", providerID: "anthropic" },
        request: new Request("https://api.anthropic.com/v1/messages"),
      }
      await app.hooks.get("http.request")?.(input as never)
      expect(input.request.url).toBe("https://api.anthropic.com/v1/messages")

      // The host would not even call the callback for another provider, and the
      // plugin's own guard does not rewrite it either: both have to hold.
      await app.registrations.get("http.request")?.[0]?.callback(input)
      expect(input.request.url).toBe("https://api.anthropic.com/v1/messages")
    } finally {
      await app.dispose()
    }
  })

  test("rewrites a free model's request for the relay", async () => {
    const app = await start()
    try {
      await app.call("addRelay", { name: "local", url, access: ACCESS })
      const status = (await app.call("status")) as StatusAnswer
      const id = firstExit(status).id
      await app.call("useExit", { id })
      await app.call("setEnabled", { enabled: true })

      const input = {
        sessionID: "routed",
        model: { id: "iceman-free", providerID: "opencode" },
        request: new Request("https://opencode.ai/inference/openai/v1/models"),
      }
      await app.hooks.get("http.request")?.(input as never)

      expect(input.request.url).toBe(`${url}/`)
      expect(input.request.headers.get("x-relay-target")).toBe("https://opencode.ai")
      expect(input.request.headers.get("x-relay-path")).toBe("/inference/openai/v1/models")
      expect(input.request.headers.get("x-relay-key")).toBe(ACCESS)
      expect(input.request.headers.get("x-relay-id")).toBe(id)

      const after = (await app.call("status")) as StatusAnswer
      expect(after.lastDecision).toMatchObject({ modelId: "iceman-free", routed: true, exitId: id })
      expect(after.exits[0]?.status).toBe("reachable")
    } finally {
      await app.dispose()
    }
  })

  test("a routed request really reaches a local relay and comes back", async () => {
    // A relay of this process's own: no network, no deployment, and every
    // request that arrives is recorded so the test can prove the rewritten
    // request actually left the plugin instead of staying at the provider.
    const seen: { url?: string; headers: Record<string, string | string[] | undefined> }[] = []
    const fake = createServer((req, res) => {
      if (req.headers["x-relay-control"] === "ping") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ egress: "127.0.0.1", runtime: "test", instance: "fake" }))
        return
      }
      seen.push({ url: req.url, headers: req.headers })
      res.writeHead(200, { "content-type": "application/json", "x-relay-runtime": "test" })
      res.end(JSON.stringify({ data: [{ id: "iceman-free" }] }))
    })
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve))
    const address = fake.address()
    if (address === null || typeof address === "string") throw new Error("the relay has no port")
    const relayUrl = `http://127.0.0.1:${address.port}`

    const app = await start()
    try {
      await app.call("addRelay", { name: "fake", url: relayUrl, access: ACCESS })
      const status = (await app.call("status")) as StatusAnswer
      await app.call("useExit", { id: firstExit(status).id })
      await app.call("setEnabled", { enabled: true })

      const input = {
        sessionID: "e2e",
        model: { id: "iceman-free", providerID: "opencode" },
        request: new Request("https://opencode.ai/inference/openai/v1/models"),
      }
      await app.hooks.get("http.request")?.(input as never)

      const answer = await fetch(input.request)
      expect(answer.status).toBe(200)
      const body = (await answer.json()) as { data: { id: string }[] }
      expect(body.data[0]?.id).toBe("iceman-free")

      expect(seen).toHaveLength(1)
      expect(seen[0]?.headers["x-relay-target"]).toBe("https://opencode.ai")
      expect(seen[0]?.headers["x-relay-path"]).toBe("/inference/openai/v1/models")
      expect(seen[0]?.headers["x-relay-key"]).toBe(ACCESS)

      const after = (await app.call("status")) as StatusAnswer
      expect(after.exits[0]?.stats.requests).toBe(1)
    } finally {
      await app.dispose()
      fake.closeAllConnections()
      await new Promise<void>((resolve) => fake.close(() => resolve()))
    }
  })

  test("a paid model stays direct, and a listed paid model is dropped", async () => {
    const app = await start()
    try {
      await app.call("addRelay", { name: "local", url, access: ACCESS })
      const status = (await app.call("status")) as StatusAnswer
      await app.call("useExit", { id: firstExit(status).id })
      await app.call("setEnabled", { enabled: true })

      const chosen = (await app.call("setSelection", {
        selection: "custom",
        models: ["iceman-free", "gpt-6.1-sol"],
      })) as { customModels: string[]; dropped: string[] }
      expect(chosen.customModels).toEqual(["iceman-free"])
      expect(chosen.dropped).toEqual(["gpt-6.1-sol"])

      const paid = {
        sessionID: "paid",
        model: { id: "gpt-6.1-sol", providerID: "opencode" },
        request: new Request("https://opencode.ai/inference/openai/v1/models"),
      }
      await app.hooks.get("http.request")?.(paid as never)
      expect(paid.request.url).toBe("https://opencode.ai/inference/openai/v1/models")

      // A custom free model still routes: the price is looked up for both
      // selections, not only for the all-free one.
      const free = {
        sessionID: "custom",
        model: { id: "iceman-free", providerID: "opencode" },
        request: new Request("https://opencode.ai/inference/openai/v1/models"),
      }
      await app.hooks.get("http.request")?.(free as never)
      expect(free.request.url).toBe(`${url}/`)
    } finally {
      await app.dispose()
    }
  })

  test("a prefixed model id is not mistaken for a free opencode model", async () => {
    const app = await start()
    try {
      await app.call("addRelay", { name: "local", url, access: ACCESS })
      const status = (await app.call("status")) as StatusAnswer
      await app.call("useExit", { id: firstExit(status).id })
      await app.call("setEnabled", { enabled: true })

      const input = {
        sessionID: "prefixed",
        model: { id: "opencode/iceman-free", providerID: "opencode" },
        request: new Request("https://opencode.ai/inference/openai/v1/models"),
      }
      await app.hooks.get("http.request")?.(input as never)
      expect(input.request.url).toBe("https://opencode.ai/inference/openai/v1/models")

      const after = (await app.call("status")) as StatusAnswer
      expect(after.lastDecision).toMatchObject({
        modelId: "opencode/iceman-free",
        routed: false,
      })
      expect(after.lastDecision?.reason).toContain("not a free model")
    } finally {
      await app.dispose()
    }
  })

  test.skipIf(!online)("a routed request really comes back from OpenCode", async () => {
    const app = await start()
    try {
      await app.call("addRelay", { name: "local", url, access: ACCESS })
      const status = (await app.call("status")) as StatusAnswer
      await app.call("useExit", { id: firstExit(status).id })
      await app.call("setEnabled", { enabled: true })

      const input = {
        sessionID: "real",
        model: { id: "iceman-free", providerID: "opencode" },
        request: new Request("https://opencode.ai/inference/openai/v1/models"),
      }
      await app.hooks.get("http.request")?.(input as never)

      const answer = await fetch(input.request)
      expect(answer.status).toBe(200)
      const body = (await answer.json()) as { data: { id: string }[] }
      expect(body.data.length).toBeGreaterThan(0)
      expect(answer.headers.get("x-relay-runtime")).toBeTruthy()
    } finally {
      await app.dispose()
    }
  })

  test("remembers the exits and the rules across a restart", async () => {
    const app = await start()
    let id = ""
    try {
      const added = (await app.call("addRelay", { name: "local", url, access: ACCESS })) as { id: string }
      id = added.id
      await app.call("useExit", { id })
      await app.call("setEnabled", { enabled: true })
      await app.call("setSelection", { selection: "custom", models: ["iceman-free"] })
      await app.call("setStrategy", { strategy: "round-robin" })
      await app.call("setDirect", { direct: "never" })
      await app.call("setHealthChecks", { enabled: false })
    } finally {
      await app.dispose()
    }

    const again = await start(true, app.store)
    try {
      const restored = (await again.call("status")) as StatusAnswer
      expect(restored.enabled).toBe(true)
      expect(restored.selection).toBe("custom")
      expect(restored.customModels).toEqual(["iceman-free"])
      expect(restored.activeExit?.id).toBe(id)
      expect(restored.strategy).toBe("round-robin")
      expect(restored.direct).toBe("never")
      expect(restored.healthChecks).toBe(false)
    } finally {
      await again.dispose()
    }
  })

  test("an installation from before the new rules keeps its choices", async () => {
    const app = await start()
    let id = ""
    try {
      const added = (await app.call("addRelay", { name: "local", url, access: ACCESS })) as { id: string }
      id = added.id
      await app.call("setEnabled", { enabled: true })
      await app.call("setSelection", { selection: "custom", models: ["iceman-free"] })
    } finally {
      await app.dispose()
    }

    // Older versions wrote "all", no strategy, no direct policy, no health
    // flag, and called the chosen exit activeRelayId.
    const settings = app.store.get("settings") as Record<string, unknown>
    settings.selection = "all"
    delete settings.strategy
    delete settings.direct
    delete settings.healthChecks
    delete settings.activeExitId
    settings.activeRelayId = id

    const again = await start(true, app.store)
    try {
      const status = (await again.call("status")) as StatusAnswer
      expect(status.selection).toBe("free")
      expect(status.strategy).toBe("fixed")
      expect(status.direct).toBe("allow")
      expect(status.healthChecks).toBe(true)
      expect(status.activeExit?.id).toBe(id)
    } finally {
      await again.dispose()
    }
  })

  test("a stored choice that points at nothing falls back to the first exit", async () => {
    const app = await start()
    let id = ""
    try {
      const added = (await app.call("addRelay", { name: "local", url, access: ACCESS })) as { id: string }
      id = added.id
    } finally {
      await app.dispose()
    }

    const settings = app.store.get("settings") as Record<string, unknown>
    settings.activeExitId = "exit-that-is-gone"

    const again = await start(true, app.store)
    try {
      const status = (await again.call("status")) as StatusAnswer
      expect(status.activeExit?.id).toBe(id)
    } finally {
      await again.dispose()
    }
  })

  test("the status payload names the exit the picker would serve", async () => {
    const store = new Map<string, unknown>()
    store.set("relays", [
      storedRelay("chosen", "chosen", "reachable"),
      storedRelay("backup", "backup", "reachable"),
    ])
    store.set("settings", storedSettings("chosen"))
    const app = await start(true, store)
    try {
      await app.call("setEnabled", { enabled: true })
      const status = (await app.call("status")) as StatusAnswer
      expect(status.servingExitId).toBe("chosen")
      expect(status.skippedExitIds).toEqual([])
      // The note is derived from the same picker result, so it cannot disagree.
      expect(status.note).toContain("through chosen")
    } finally {
      await app.dispose()
    }
  })

  test("the status names the exit that will serve, not an unusable chosen one", async () => {
    const store = new Map<string, unknown>()
    store.set("relays", [
      // The old note counted an untested exit as usable, so it named the chosen
      // one even though the picker would skip it and use the backup.
      storedRelay("chosen", "chosen", "untested"),
      storedRelay("backup", "backup", "reachable"),
    ])
    store.set("settings", storedSettings("chosen"))
    const app = await start(true, store)
    try {
      await app.call("setEnabled", { enabled: true })
      const status = (await app.call("status")) as StatusAnswer
      expect(status.exits.find((exit) => exit.id === "chosen")?.status).toBe("untested")
      expect(status.note).toContain("so backup takes over")
      expect(status.note).not.toContain("through chosen")
      // The payload carries the picker's answer itself, not only the note.
      expect(status.servingExitId).toBe("backup")
      expect(status.skippedExitIds).toEqual(["chosen"])
    } finally {
      await app.dispose()
    }
  })

  test("with every exit untested, the status says the request goes direct", async () => {
    const store = new Map<string, unknown>()
    store.set("relays", [storedRelay("fresh", "fresh", "untested")])
    store.set("settings", storedSettings("fresh"))
    const app = await start(true, store)
    try {
      await app.call("setEnabled", { enabled: true })
      const status = (await app.call("status")) as StatusAnswer
      expect(status.note).toContain("no exit can serve")
      expect(status.note).toContain("Requests go direct")
      expect(status.note).not.toContain("through fresh")
      // The picker names nothing, and says which exit it left out.
      expect(status.servingExitId).toBeUndefined()
      expect(status.skippedExitIds).toEqual(["fresh"])
    } finally {
      await app.dispose()
    }
  })

  test("the status carries the imported mark, and only when it is set", async () => {
    const store = new Map<string, unknown>()
    store.set("relays", [
      { ...storedRelay("imported", "imported", "reachable"), imported: true },
      storedRelay("normal", "normal", "reachable"),
    ])
    store.set("settings", storedSettings("imported"))
    const app = await start(true, store)
    try {
      const status = (await app.call("status")) as StatusAnswer
      expect(status.exits.find((exit) => exit.id === "imported")?.imported).toBe(true)
      // A missing mark is not written as false: an older reader sees the same
      // record it always did.
      expect(status.exits.find((exit) => exit.id === "normal")?.imported).toBeUndefined()
    } finally {
      await app.dispose()
    }
  })

  test("a paused chosen exit is not named while another exit serves", async () => {
    const store = new Map<string, unknown>()
    store.set("relays", [
      storedRelay("chosen", "chosen", "reachable"),
      storedRelay("backup", "backup", "reachable"),
    ])
    store.set("settings", storedSettings("chosen"))
    const app = await start(true, store)
    try {
      await app.call("setEnabled", { enabled: true })
      await app.call("setExitEnabled", { id: "chosen", enabled: false })

      const status = (await app.call("status")) as StatusAnswer
      expect(status.paused).toContain("chosen")
      expect(status.note).toContain("so backup takes over")
      expect(status.note).not.toContain("through chosen")
      expect(status.servingExitId).toBe("backup")

      // Pause the last usable exit too: now the note must not promise routing
      // through anything at all.
      await app.call("setExitEnabled", { id: "backup", enabled: false })
      const none = (await app.call("status")) as StatusAnswer
      expect(none.note).toContain("no exit can serve")
      expect(none.note).toContain("Requests go direct")
      expect(none.servingExitId).toBeUndefined()
    } finally {
      await app.dispose()
    }
  })

  test("the access token and a proxy password never leave the server", async () => {
    const app = await start()
    try {
      await app.call("addRelay", { name: "local", url, access: ACCESS })
      await app.call("addProxies", { text: "alice:secret@1.2.3.4:8080" })
      const status = JSON.stringify(await app.call("status"))
      expect(status).not.toContain(ACCESS)
      expect(status).not.toContain("secret")
      expect(status).not.toContain("alice")
      // The proxy is still listed, with its credentials taken out.
      const answer = (await app.call("status")) as StatusAnswer
      expect(answer.exits.some((exit) => exit.kind === "proxy" && exit.url.includes("***@"))).toBe(true)
    } finally {
      await app.dispose()
    }
  })

  test("the first exit becomes the chosen one, and removing it hands the choice on", async () => {
    const app = await start()
    try {
      const one = (await app.call("addRelay", { name: "one", url, access: ACCESS })) as { id: string }
      const two = (await app.call("addRelay", { name: "two", url, access: ACCESS })) as { id: string }
      const status = (await app.call("status")) as StatusAnswer
      expect(status.activeExit?.id).toBe(one.id)

      await app.call("useExit", { id: one.id })
      const removed = (await app.call("removeRelay", { id: one.id, deleteProject: false })) as {
        removed: boolean
        projectDeleted: boolean
      }
      expect(removed).toEqual({ removed: true, projectDeleted: false })

      const after = (await app.call("status")) as StatusAnswer
      expect(after.activeExit?.id).toBe(two.id)
      expect(after.note).not.toContain("no relay")
    } finally {
      await app.dispose()
    }
  })

  test("round robin spreads the requests over the exits", async () => {
    const app = await start()
    try {
      const one = (await app.call("addRelay", { name: "one", url, access: ACCESS })) as { id: string }
      const two = (await app.call("addRelay", { name: "two", url, access: ACCESS })) as { id: string }
      await app.call("setEnabled", { enabled: true })
      await app.call("setStrategy", { strategy: "round-robin" })

      const send = async (sessionID: string) => {
        const input = {
          sessionID,
          model: { id: "iceman-free", providerID: "opencode" },
          request: new Request("https://opencode.ai/inference/openai/v1/models"),
        }
        await app.hooks.get("http.request")?.(input as never)
        return input.request
      }

      const first = await send("rr-1")
      const second = await send("rr-2")
      const third = await send("rr-3")

      expect(first.headers.get("x-relay-id")).toBe(one.id)
      expect(second.headers.get("x-relay-id")).toBe(two.id)
      expect(third.headers.get("x-relay-id")).toBe(one.id)
    } finally {
      await app.dispose()
    }
  })

  test("a relay that asks for another instance is rested and the next one serves", async () => {
    const app = await start()
    try {
      const one = (await app.call("addRelay", { name: "one", url, access: ACCESS })) as { id: string }
      const two = (await app.call("addRelay", { name: "two", url, access: ACCESS })) as { id: string }
      await app.call("useExit", { id: one.id })
      await app.call("setEnabled", { enabled: true })

      const request = relayRequest(
        new Request("https://opencode.ai/inference/openai/v1/models"),
        { url, access: ACCESS, id: one.id },
      )
      await app.hooks.get("http.response")?.({
        sessionID: "rotate",
        model: { id: "iceman-free", providerID: "opencode" },
        request,
        response: new Response("{}", {
          status: 409,
          headers: {
            "x-relay-rotate": "1",
            "x-relay-egress": "203.0.113.9",
            "x-relay-runtime": "bun",
          },
        }),
      } as never)

      // The rotate is the relay echoing the plugin's avoid list, and nothing
      // marked 203.0.113.9 spent, so the echo is stale: the relay rests for a
      // short while instead of being retired until the address's window ends.
      const rested = (await app.call("status")) as StatusAnswer
      expect(rested.exhausted).toEqual([])
      expect(rested.exits.find((exit) => exit.id === one.id)?.status).toBe("limited")
      expect(rested.skipped).toContain(one.id)

      const next = {
        sessionID: "rotate-next",
        model: { id: "iceman-free", providerID: "opencode" },
        request: new Request("https://opencode.ai/inference/openai/v1/models"),
      }
      await app.hooks.get("http.request")?.(next as never)
      expect(next.request.headers.get("x-relay-id")).toBe(two.id)
      // A stale echo is not evidence that the address is used up, so it must
      // not put the address on the avoid list either.
      expect(next.request.headers.get("x-relay-avoid")).toBeNull()

      // Clearing used-up latches is not a way to cut the live rest short: the
      // relay that asked for another instance still sits it out.
      const cleared = (await app.call("resetExhausted")) as { restored: string[] }
      expect(cleared.restored).toEqual([])
      const afterReset = {
        sessionID: "rotate-back",
        model: { id: "iceman-free", providerID: "opencode" },
        request: new Request("https://opencode.ai/inference/openai/v1/models"),
      }
      await app.hooks.get("http.request")?.(afterReset as never)
      expect(afterReset.request.headers.get("x-relay-id")).toBe(two.id)
    } finally {
      await app.dispose()
    }
  })

  test("a 429 is only a suspicion until a canary agrees", async () => {
    const app = await start()
    try {
      const added = (await app.call("addRelay", { name: "local", url, access: ACCESS })) as { id: string }
      await app.call("useExit", { id: added.id })
      await app.call("setEnabled", { enabled: true })

      // No request was routed in this session, so there is no real request to
      // shape a canary from. The safe verdict is a rest, not a retirement.
      const request = relayRequest(
        new Request("https://opencode.ai/inference/openai/v1/models"),
        { url, access: ACCESS, id: added.id },
      )
      await app.hooks.get("http.response")?.({
        sessionID: "suspect",
        model: { id: "iceman-free", providerID: "opencode" },
        request,
        response: new Response('{"error":{"message":"Free usage limit reached"}}', {
          status: 429,
          headers: { "x-relay-egress": "203.0.113.11" },
        }),
      } as never)

      const after = (await app.call("status")) as StatusAnswer
      expect(after.exhausted).toEqual([])
      expect(after.skipped).toContain(added.id)
      expect(after.exits.find((exit) => exit.id === added.id)?.status).toBe("limited")

      // A refused request is not retried through another address: the request
      // was the problem, not the exit.
      const retry = {
        sessionID: "suspect",
        model: { id: "iceman-free", providerID: "opencode" },
        error: {
          status: 429,
          response: { body: '{"error":{"message":"Free usage limit reached"}}' },
        },
        attempt: 1,
        decision: { retry: false },
      }
      await app.hooks.get("retry")?.(retry as never)
      expect(retry.decision).toEqual({ retry: false })
    } finally {
      await app.dispose()
    }
  })

  test("a relay that did not answer is never used", async () => {
    const app = await start()
    try {
      // Port 9 is the discard port: nothing listens there, so the probe fails.
      const dead = (await app.call("addRelay", {
        name: "dead end",
        url: "http://127.0.0.1:9",
        access: ACCESS,
      })) as { id: string; reachable: boolean }
      expect(dead.reachable).toBe(false)
      await app.call("useExit", { id: dead.id })
      await app.call("setEnabled", { enabled: true })

      const input = {
        sessionID: "dead",
        model: { id: "iceman-free", providerID: "opencode" },
        request: new Request("https://opencode.ai/inference/openai/v1/models"),
      }
      await app.hooks.get("http.request")?.(input as never)
      expect(input.request.url).toBe("https://opencode.ai/inference/openai/v1/models")

      const status = (await app.call("status")) as StatusAnswer
      expect(status.exits.find((exit) => exit.id === dead.id)?.status).toBe("unreachable")
      // The dead relay is resting, not retired: a rest is what brings it back
      // into use without the user having to test it by hand.
      expect(status.skipped).toContain(dead.id)
      expect(status.note).toContain("no exit can serve")
    } finally {
      await app.dispose()
    }
  })

  test("a probe that started before a live verdict cannot overwrite it", async () => {
    // The relay answers the first-check probe slowly. While the probe is out, a
    // live verdict refuses the exit; the probe's "reachable" is stale and must
    // not clear the live "blocked".
    let release: (() => void) | undefined
    let arrived: (() => void) | undefined
    const reached = new Promise<void>((resolve) => {
      arrived = resolve
    })
    const fake = createServer((_request, response) => {
      release = () => {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ egress: "127.0.0.1", runtime: "test" }))
      }
      arrived?.()
    })
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve))
    const address = fake.address()
    if (address === null || typeof address === "string") throw new Error("the fake relay has no port")

    const store = new Map<string, unknown>()
    const storage = {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => {
        store.set(key, value)
      },
      remove: async (key: string) => {
        store.delete(key)
      },
      scan: async () => ({ entries: [] }),
    }
    const state = new RelayState(storage as never)
    const handlers = createHandlers({
      state,
      catalog: {} as never,
      bridge: {} as never,
      tester: {} as never,
      announce: async () => {},
    })

    try {
      const adding = handlers.addRelay(
        { name: "slow", url: `http://127.0.0.1:${address.port}`, access: ACCESS },
        {} as never,
      )
      await reached
      const relay = state.exits()[0]
      if (!relay) throw new Error("the relay was not added")
      expect(relay.status).toBe("untested")

      // The live verdict lands while the probe is still in flight.
      state.markBlocked(relay.id, "OpenCode refused this exit.")
      release?.()

      const added = (await adding) as { reachable: boolean }
      expect(added.reachable).toBe(true)
      expect(state.exit(relay.id)?.status).toBe("blocked")
      // The stale answer did not even leave a check time on the live record.
      expect(state.exit(relay.id)?.lastCheck).toBeUndefined()
    } finally {
      fake.closeAllConnections()
      await new Promise<void>((resolve) => fake.close(() => resolve()))
    }
  })

  test("a transport failure rests the exit, and the next request goes direct", async () => {
    const app = await start()
    try {
      await app.call("addRelay", { name: "local", url, access: ACCESS })
      const status = (await app.call("status")) as StatusAnswer
      const id = firstExit(status).id
      await app.call("useExit", { id })
      await app.call("setEnabled", { enabled: true })

      const first = {
        sessionID: "transport",
        model: { id: "iceman-free", providerID: "opencode" },
        request: new Request("https://opencode.ai/inference/openai/v1/models"),
      }
      await app.hooks.get("http.request")?.(first as never)
      expect(first.request.url).toContain(url)

      const retry = {
        sessionID: "transport",
        model: { id: "iceman-free", providerID: "opencode" },
        error: { message: "fetch failed" },
        attempt: 1,
        decision: { retry: false } as { retry: boolean; delay?: number },
      }
      await app.hooks.get("retry")?.(retry as never)
      expect(retry.decision).toEqual({ retry: true, delay: ROTATE_DELAY_MS })

      const second = {
        sessionID: "transport",
        model: { id: "iceman-free", providerID: "opencode" },
        request: new Request("https://opencode.ai/inference/openai/v1/models"),
      }
      await app.hooks.get("http.request")?.(second as never)
      expect(second.request.url).toBe("https://opencode.ai/inference/openai/v1/models")

      const after = (await app.call("status")) as StatusAnswer
      expect(after.skipped).toContain(id)
    } finally {
      await app.dispose()
    }
  })

  test("a server error is retried and the exit is rested", async () => {
    const app = await start()
    try {
      await app.call("addRelay", { name: "local", url, access: ACCESS })
      const status = (await app.call("status")) as StatusAnswer
      const id = firstExit(status).id
      await app.call("useExit", { id })
      await app.call("setEnabled", { enabled: true })

      await app.hooks.get("http.request")?.({
        sessionID: "failing",
        model: { id: "iceman-free", providerID: "opencode" },
        request: new Request("https://opencode.ai/inference/openai/v1/models"),
      } as never)

      const retry = {
        sessionID: "failing",
        model: { id: "iceman-free", providerID: "opencode" },
        error: { status: 502, message: "Upstream request failed" },
        attempt: 1,
        decision: { retry: false } as { retry: boolean; delay?: number },
      }
      await app.hooks.get("retry")?.(retry as never)
      expect(retry.decision).toEqual({ retry: true, delay: ROTATE_DELAY_MS })

      const after = (await app.call("status")) as StatusAnswer
      expect(after.skipped).toContain(id)
    } finally {
      await app.dispose()
    }
  })

  test("a retry is never asked for a request this plugin did not route", async () => {
    const app = await start()
    try {
      const retry = {
        sessionID: "direct",
        model: { id: "iceman-free", providerID: "opencode" },
        error: { status: 409 },
        attempt: 1,
        decision: { retry: false },
      }
      await app.hooks.get("retry")?.(retry as never)
      expect(retry.decision).toEqual({ retry: false })
    } finally {
      await app.dispose()
    }
  })

  test("direct routing can be forbidden", async () => {
    const app = await start()
    try {
      await app.call("setEnabled", { enabled: true })
      await app.call("setDirect", { direct: "never" })

      const input = {
        sessionID: "never",
        model: { id: "iceman-free", providerID: "opencode" },
        request: new Request("https://opencode.ai/inference/openai/v1/models"),
      }
      await expect(app.hooks.get("http.request")?.(input as never)).rejects.toThrow(
        /never go direct/i,
      )
      expect(input.request.url).toBe("https://opencode.ai/inference/openai/v1/models")
    } finally {
      await app.dispose()
    }
  })

  test("the preview says where the next request would go, and why not elsewhere", async () => {
    type Preview = {
      routed: boolean
      reason: string
      exit?: { id: string }
      skipped: readonly { name: string; reason: string }[]
    }
    const app = await start()
    try {
      await app.call("addRelay", { name: "local", url, access: ACCESS })
      await app.call("setEnabled", { enabled: true })

      // No model was named: the answer is about a free model, and says so
      // instead of promising the next request of any kind goes through.
      const free = (await app.call("preview", {})) as Preview
      expect(free.routed).toBe(true)
      expect(free.exit).toBeDefined()
      expect(free.reason).toContain("free opencode model")
      expect(free.reason).toContain("other providers go direct")

      const chosen = (await app.call("preview", {
        modelId: "iceman-free",
        providerID: "opencode",
      })) as Preview
      expect(chosen.routed).toBe(true)

      const other = (await app.call("preview", {
        modelId: "iceman-free",
        providerID: "polygate",
      })) as Preview
      expect(other.routed).toBe(false)
      expect(other.reason).toContain("polygate")
      expect(other.reason).toContain("opencode")

      const paid = (await app.call("preview", {
        modelId: "gpt-6.1-sol",
        providerID: "opencode",
      })) as Preview
      expect(paid.routed).toBe(false)
      expect(paid.reason).toContain("not a free model")

      await app.call("setEnabled", { enabled: false })
      const off = (await app.call("preview", {})) as Preview
      expect(off.routed).toBe(false)
      expect(off.reason).toContain("Routing is off")
    } finally {
      await app.dispose()
    }
  })

  test("the preview names the provider it is about, whichever way it goes", async () => {
    type Preview = {
      routed: boolean
      reason: string
      providerID?: string
      exit?: { id: string }
      skipped: readonly { name: string; reason: string }[]
    }
    const app = await start()
    try {
      await app.call("addRelay", { name: "local", url, access: ACCESS })
      await app.call("setEnabled", { enabled: true })

      // Every answer carries the provider it is about, so the caller never
      // has to guess which provider a verdict belonged to.
      const routed = (await app.call("preview", {
        modelId: "iceman-free",
        providerID: "opencode",
      })) as Preview
      expect(routed.providerID).toBe("opencode")

      // No model named, routing on: the answer is about the free models.
      const free = (await app.call("preview", { providerID: "opencode" })) as Preview
      expect(free.providerID).toBe("opencode")

      // Routing off, and the case where nothing can serve.
      await app.call("setEnabled", { enabled: false })
      const off = (await app.call("preview", { providerID: "polygate" })) as Preview
      expect(off.providerID).toBe("polygate")
    } finally {
      await app.dispose()
    }
  })

  test("a named model says it would still go direct with routing off", async () => {
    type Preview = {
      routed: boolean
      reason: string
      skipped: readonly { name: string; reason: string }[]
    }
    const app = await start()
    try {
      await app.call("addRelay", { name: "local", url, access: ACCESS })
      await app.call("setEnabled", { enabled: false })

      // The provider decides before the switch does: even with routing on,
      // a polygate model would never be routed. Hiding that behind the
      // routing-off answer would leave the user to turn routing on and then
      // discover the model still goes direct.
      const other = (await app.call("preview", {
        modelId: "iceman-free",
        providerID: "polygate",
      })) as Preview
      expect(other.routed).toBe(false)
      expect(other.reason).toContain("polygate")
      expect(other.reason).toContain("Routing is off")

      const chosen = (await app.call("preview", {
        modelId: "iceman-free",
        providerID: "opencode",
      })) as Preview
      expect(chosen.routed).toBe(false)
      expect(chosen.reason).toContain("Routing is off")
    } finally {
      await app.dispose()
    }
  })

  test("a proxy list is read, deduplicated and reported", async () => {
    const app = await start()
    try {
      const added = (await app.call("addProxies", {
        text: `
          1.2.3.4:8080
          socks5://5.6.7.8:1080
          http://1.2.3.4:8080
          notaproxy
        `,
      })) as {
        added: readonly { id: string; name: string; url: string }[]
        invalid: readonly { value: string; reason: string }[]
        duplicates: number
      }

      expect(added.added).toHaveLength(2)
      expect(added.duplicates).toBe(1)
      expect(added.invalid).toHaveLength(1)
      expect(added.added[0]?.url).toBe("http://1.2.3.4:8080")

      const status = (await app.call("status")) as StatusAnswer
      expect(status.exits.filter((exit) => exit.kind === "proxy")).toHaveLength(2)

      const proxy = status.exits.find((exit) => exit.kind === "proxy")
      if (!proxy) throw new Error("the proxy was not stored")
      const removed = (await app.call("removeExit", { id: proxy.id })) as { removed: boolean }
      expect(removed.removed).toBe(true)
      const after = (await app.call("status")) as StatusAnswer
      expect(after.exits.some((exit) => exit.id === proxy.id)).toBe(false)
    } finally {
      await app.dispose()
    }
  })

  test("a proxy can be paused, resumed and edited", async () => {
    const app = await start()
    try {
      const added = (await app.call("addProxies", { text: "1.2.3.4:8080" })) as {
        added: readonly { id: string }[]
      }
      const id = added.added[0]?.id
      if (!id) throw new Error("the proxy was not added")

      await app.call("setExitEnabled", { id, enabled: false })
      let status = (await app.call("status")) as StatusAnswer
      expect(status.paused).toContain(id)
      expect(status.exits.find((exit) => exit.id === id)?.enabled).toBe(false)

      await app.call("setExitEnabled", { id, enabled: true })
      status = (await app.call("status")) as StatusAnswer
      expect(status.paused).not.toContain(id)

      const updated = (await app.call("updateProxy", {
        id,
        name: "home proxy",
        url: "socks5://user:pass@9.9.9.9:1080",
      })) as { updated: boolean }
      expect(updated.updated).toBe(true)

      status = (await app.call("status")) as StatusAnswer
      const proxy = status.exits.find((exit) => exit.id === id)
      expect(proxy?.name).toBe("home proxy")
      expect(proxy?.url).toBe("socks5://***@9.9.9.9:1080")
      expect(proxy?.status).toBe("untested")
    } finally {
      await app.dispose()
    }
  })

  test("editing a proxy address keeps the credentials it does not replace", async () => {
    const app = await start()
    try {
      const added = (await app.call("addProxies", { text: "socks5://user:pass@1.2.3.4:1080" })) as {
        added: readonly { id: string }[]
      }
      const id = added.added[0]?.id
      if (!id) throw new Error("the proxy was not added")

      // The address is shown with its credentials masked, so a user who edits
      // only the port hands over an address with no credentials. Those are
      // kept, or the proxy would quietly stop authenticating.
      const updated = (await app.call("updateProxy", { id, url: "socks5://1.2.3.4:1081" })) as {
        updated: boolean
      }
      expect(updated.updated).toBe(true)

      const status = (await app.call("status")) as StatusAnswer
      const proxy = status.exits.find((exit) => exit.id === id)
      expect(proxy?.url).toBe("socks5://***@1.2.3.4:1081")

      // Credentials the new address does carry replace the stored ones.
      const replaced = (await app.call("updateProxy", {
        id,
        url: "socks5://other:secret@1.2.3.4:1082",
      })) as { updated: boolean }
      expect(replaced.updated).toBe(true)
      const after = (await app.call("status")) as StatusAnswer
      expect(after.exits.find((exit) => exit.id === id)?.url).toBe("socks5://***@1.2.3.4:1082")

      // A different host gets no credentials: handing one provider's
      // password to another host is worse than dropping it.
      const moved = (await app.call("updateProxy", { id, url: "socks5://9.9.9.9:1080" })) as {
        updated: boolean
      }
      expect(moved.updated).toBe(true)
      const elsewhere = (await app.call("status")) as StatusAnswer
      expect(elsewhere.exits.find((exit) => exit.id === id)?.url).toBe("socks5://9.9.9.9:1080")
    } finally {
      await app.dispose()
    }
  })

  test("export and import move exits and rules, but never accounts", async () => {
    const source = await start()
    let json = ""
    try {
      await source.call("addRelay", { name: "local", url, access: ACCESS })
      await source.call("setEnabled", { enabled: true })
      await source.call("setStrategy", { strategy: "fastest" })
      await source.call("addProxies", { text: "1.2.3.4:8080" })
      const exported = (await source.call("exportConfig", {})) as { json: string }
      json = exported.json
      expect(json).toContain(ACCESS)
    } finally {
      await source.dispose()
    }

    const target = await start()
    try {
      const imported = (await target.call("importConfig", { json })) as {
        relays: number
        proxies: number
        invalid: number
      }
      expect(imported).toEqual({ relays: 1, proxies: 1, invalid: 0 })

      const status = (await target.call("status")) as StatusAnswer
      expect(status.enabled).toBe(false)
      expect(status.strategy).toBe("fastest")
      expect(status.exits).toHaveLength(2)
      expect(status.exits.some((exit) => exit.kind === "relay")).toBe(true)
      expect(status.exits.some((exit) => exit.kind === "proxy")).toBe(true)
    } finally {
      await target.dispose()
    }
  })

  test("importing a configuration does not probe the imported relay", async () => {
    let requests = 0
    const fake = createServer((_request, response) => {
      requests += 1
      response.writeHead(200, { "content-type": "application/json" })
      response.end("{}")
    })
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve))
    const address = fake.address()
    if (address === null || typeof address === "string") {
      throw new Error("the fake relay has no port")
    }
    const relayUrl = `http://127.0.0.1:${address.port}`

    const app = await start()
    try {
      const config = JSON.stringify({
        version: 1,
        relays: [
          { name: "imported relay", url: relayUrl, access: ACCESS, region: "", project: "vercel-project" },
        ],
        proxies: [],
        settings: { healthChecks: true },
      })
      const imported = (await app.call("importConfig", { json: config })) as {
        relays: number
        proxies: number
        invalid: number
      }
      expect(imported).toEqual({ relays: 1, proxies: 0, invalid: 0 })

      // The old import started a background scan immediately, which replayed
      // the last real request's headers (authorization included) to whatever
      // URL the config named. A scan would reach this stub in milliseconds.
      await Bun.sleep(250)
      expect(requests).toBe(0)

      const status = (await app.call("status")) as StatusAnswer
      expect(status.scanning).toBeUndefined()
      expect(firstExit(status).status).toBe("untested")
    } finally {
      await app.dispose()
      fake.closeAllConnections()
      await new Promise<void>((resolve) => fake.close(() => resolve()))
    }
  })

  test("a scan leaves imported exits untested until the user tests one", async () => {
    const store = new Map<string, unknown>()
    const storage = {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => {
        store.set(key, value)
      },
      remove: async (key: string) => {
        store.delete(key)
      },
      scan: async () => ({ entries: [] }),
    }
    const state = new RelayState(storage as never)
    await state.load()
    const tester = new Tester({ state, announce: async () => {} })
    const handlers = createHandlers({
      state,
      catalog: {} as never,
      bridge: {} as never,
      tester,
      announce: async () => {},
    })
    await handlers.setEnabled({ enabled: true }, {} as never)

    const imported = (await handlers.importConfig(
      {
        json: JSON.stringify({
          version: 1,
          relays: [{ name: "imported relay", url: "http://127.0.0.1:9", access: ACCESS }],
          proxies: ["http://127.0.0.1:1"],
          settings: { healthChecks: true },
        }),
      },
      {} as never,
    )) as { relays: number; proxies: number; invalid: number }
    expect(imported).toEqual({ relays: 1, proxies: 1, invalid: 0 })
    const relayExit = state.relays()[0]!
    const proxyExit = state.proxies()[0]!
    expect(relayExit.imported).toBe(true)
    expect(proxyExit.imported).toBe(true)
    expect(state.settings().enabled).toBe(true)
    expect(state.settings().healthChecks).toBe(true)

    // A check this stub answers would promote any exit it asked: the answer is
    // a model list through a relay that says it reached the upstream, which is
    // exactly what a sweep must not do to an imported address.
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "iceman-free" }] }), {
        status: 200,
        headers: { "content-type": "application/json", "x-relay-egress": "203.0.113.40" },
      })) as unknown as typeof fetch
    try {
      await tester.scan("api")

      expect(state.exit(relayExit.id)?.status).toBe("untested")
      expect(state.exit(proxyExit.id)?.status).toBe("untested")
      const swept = state.pickExit({ advance: false })
      expect(swept.exit).toBeUndefined()
      expect(swept.skipped.map((entry) => entry.id).sort()).toEqual([relayExit.id, proxyExit.id].sort())
      expect(swept.skipped.every((entry) => entry.reason === "imported - test it to use it")).toBe(true)

      // The user's own test clears the import mark, and a check run after it
      // can promote the exit; without that, the sweep never would.
      await state.markTested(relayExit.id)
      const result = await tester.test(relayExit.id, "api")
      expect(result.status).toBe("reachable")
      expect(state.pickExit({ advance: false }).exit?.id).toBe(relayExit.id)
    } finally {
      globalThis.fetch = original
    }
  })

  test("a deep test that proves nothing leaves an imported exit imported", async () => {
    const store = new Map<string, unknown>()
    const storage = {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => {
        store.set(key, value)
      },
      remove: async (key: string) => {
        store.delete(key)
      },
      scan: async () => ({ entries: [] }),
    }
    const state = new RelayState(storage as never)
    await state.load()
    const tester = new Tester({ state, announce: async () => {} })
    const handlers = createHandlers({
      state,
      catalog: {} as never,
      bridge: {} as never,
      tester,
      announce: async () => {},
    })
    await handlers.setEnabled({ enabled: true }, {} as never)

    const imported = (await handlers.importConfig(
      {
        json: JSON.stringify({
          version: 1,
          relays: [{ name: "imported relay", url: "http://127.0.0.1:9", access: ACCESS }],
          proxies: [],
        }),
      },
      {} as never,
    )) as { relays: number }
    expect(imported.relays).toBe(1)
    const relayExit = state.relays()[0]!
    expect(relayExit.imported).toBe(true)

    // No routed request was ever captured, so a deep test has no headers to
    // replay and can learn nothing.
    const result = (await handlers.testExit({ id: relayExit.id, deep: true }, {} as never)) as {
      ok: boolean
      status: string
    }
    expect(result.status).toBe("unknown")

    // The mark must survive a test that proved nothing: the ten-minute sweep
    // promotes via the api check, and an unvetted address must not ride it.
    expect(state.exit(relayExit.id)?.imported).toBe(true)
    const swept = state.pickExit({ advance: false })
    expect(swept.exit).toBeUndefined()
    expect(swept.skipped.map((entry) => entry.id)).toContain(relayExit.id)
  })

  test("an imported relay is tracked only, never an update target", async () => {
    const app = await start()
    try {
      const config = JSON.stringify({
        version: 1,
        relays: [
          {
            name: "imported relay",
            url: "http://127.0.0.1:9",
            access: ACCESS,
            region: "fra1",
            project: "vercel-project",
          },
        ],
      })
      const imported = (await app.call("importConfig", { json: config })) as {
        relays: number
        proxies: number
        invalid: number
      }
      expect(imported).toEqual({ relays: 1, proxies: 0, invalid: 0 })

      const status = (await app.call("status")) as StatusAnswer
      const relay = status.exits.find((exit) => exit.kind === "relay")
      expect(relay?.project).toBe("")
      expect(relay?.accountId).toBe("")

      // With no project and no account there is nothing update-all can deploy.
      const updated = (await app.call("updateAllRelays", {})) as {
        updated: number
        failed: unknown[]
        skipped: unknown[]
      }
      expect(updated.updated).toBe(0)
      expect(updated.failed).toEqual([])
      // A tracked relay was never an update target, so it is not named as one
      // left alone either: the user did not ask for it to be updated.
      expect(updated.skipped).toHaveLength(0)
    } finally {
      await app.dispose()
    }
  })

  test("a configuration that is not JSON says so, and imports nothing", async () => {
    const app = await start()
    try {
      const imported = (await app.call("importConfig", { json: "{not json" })) as {
        relays: number
        proxies: number
        invalid: number
        error?: string
      }
      // The file was never read, so no entry was left out of it: saying
      // "one entry" would send the user hunting for a bad entry.
      expect(imported.relays).toBe(0)
      expect(imported.proxies).toBe(0)
      expect(imported.invalid).toBe(0)
      expect(imported.error).toContain("not valid JSON")
    } finally {
      await app.dispose()
    }
  })

  test("an oversized configuration is refused by its byte length", async () => {
    const store = new Map<string, unknown>()
    store.set("relays", [storedRelay("one", "one", "reachable")])
    store.set("settings", storedSettings("one"))
    const app = await start(true, store)
    try {
      // Valid JSON, under the cap in characters but over it in bytes: the
      // message says 2 MB, so the cap has to count bytes, not UTF-16 units.
      const json = JSON.stringify({ version: 1, padding: "é".repeat(1_200_000) })
      expect(json.length).toBeLessThan(2 * 1024 * 1024)
      expect(Buffer.byteLength(json, "utf8")).toBeGreaterThan(2 * 1024 * 1024)

      const imported = (await app.call("importConfig", { json })) as {
        relays: number
        proxies: number
        invalid: number
        error?: string
      }
      // The file was not read at all, so no entry was left out of it: the
      // reason says what actually happened.
      expect(imported.relays).toBe(0)
      expect(imported.proxies).toBe(0)
      expect(imported.invalid).toBe(0)
      expect(imported.error).toContain("larger than 2 MB")

      await app.call("setEnabled", { enabled: true })
      const status = (await app.call("status")) as StatusAnswer
      expect(status.note).toContain("larger than 2 MB")
    } finally {
      await app.dispose()
    }
  })

  test("a configuration imported twice is not duplicated", async () => {
    const config = JSON.stringify({
      version: 1,
      relays: [
        {
          name: "imported relay",
          url: "http://127.0.0.1:9",
          access: ACCESS,
          region: "",
          project: "",
        },
      ],
      // The passwords differ in case, so they authenticate differently and
      // both must survive the import and its deduplication.
      proxies: [
        { name: "capital", url: "http://user:PaSs@1.2.3.4:8080" },
        "http://user:pass@1.2.3.4:8080",
      ],
      settings: {
        selection: "free",
        strategy: "fixed",
        direct: "allow",
        customModels: [],
        healthChecks: true,
      },
    })
    const app = await start()
    try {
      const first = (await app.call("importConfig", { json: config })) as {
        relays: number
        proxies: number
        invalid: number
      }
      expect(first).toEqual({ relays: 1, proxies: 2, invalid: 0 })

      // The same export again: nothing is added, and the counts say so. The
      // entries that were already there are counted as duplicates, so
      // "nothing new" is not the same answer as "the file was empty".
      const second = (await app.call("importConfig", { json: config })) as {
        relays: number
        proxies: number
        invalid: number
        duplicates?: number
      }
      expect(second.relays).toBe(0)
      expect(second.proxies).toBe(0)
      expect(second.invalid).toBe(0)
      expect(second.duplicates).toBe(3)

      const status = (await app.call("status")) as StatusAnswer
      expect(status.exits).toHaveLength(3)
    } finally {
      await app.dispose()
    }
  })

  test("a test of an exit says whether OpenCode can be reached through it", async () => {
    const app = await start()
    try {
      const added = (await app.call("addRelay", { name: "local", url, access: ACCESS })) as { id: string }
      // The API check reaches the real provider, which may answer a probe
      // and then drop the next request. The check is asked again until the
      // budget is spent, so a single blip does not read as a broken exit.
      let result = { ok: false, status: "", code: 0, ms: 0 } as {
        ok: boolean
        status: string
        code: number
        ms: number
        egress?: string
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        result = (await app.call("testExit", { id: added.id })) as typeof result
        if (result.ok) break
        await Bun.sleep(500)
      }
      expect(result.ms).toBeGreaterThanOrEqual(0)
      // The answer and the stored verdict must agree, whatever the network
      // did: the check reports what it saw, and the record says the same.
      const status = (await app.call("status")) as StatusAnswer
      const stored = status.exits.find((exit) => exit.id === added.id)
      if (result.ok) {
        expect(result.status).toBe("reachable")
        expect(result.code).toBe(200)
        expect(stored?.status).toBe("reachable")
      } else {
        expect(stored?.status).not.toBe("reachable")
      }
    } finally {
      await app.dispose()
    }
  })

  test("a relay address that cannot be read is refused, not crashed on", async () => {
    const app = await start()
    try {
      // A port that is not a number makes the address unreadable: the call
      // has to say so, not fall over.
      const answer = (await app.call("addRelay", {
        name: "broken",
        url: "https://relay.example.com:99999",
        access: ACCESS,
      })) as { tag?: string; message?: string }
      expect(answer.tag).toBe("insecure_relay")
      expect(answer.message).toContain("could not be read")

      const status = (await app.call("status")) as StatusAnswer
      expect(status.exits).toHaveLength(0)
    } finally {
      await app.dispose()
    }
  })

  test("an imported relay with control characters in its name is cleaned", async () => {
    const app = await start()
    try {
      // A name from a file can carry escape sequences: they would be drawn in
      // the menu, in a toast and on a page.
      const config = JSON.stringify({
        version: 1,
        relays: [{ name: "bad\u001b[31mname", url: "https://relay.example.com", access: ACCESS }],
        proxies: [],
      })
      await app.call("importConfig", { json: config })

      const status = (await app.call("status")) as StatusAnswer
      const relay = status.exits.find((exit) => exit.kind === "relay")
      expect(relay?.name).toBe("badname")
      expect(relay?.name).not.toContain("")
    } finally {
      await app.dispose()
    }
  })

  test("a change that could not be saved is reported as such", async () => {
    // The disk is full: the relay is in memory but never on disk.
    const app = await start(true, undefined, ["relays"])
    try {
      const answer = (await app.call("addRelay", { name: "local", url, access: ACCESS })) as {
        tag?: string
        message?: string
        data?: { message?: string }
      }
      // A change that looks saved and is not would be lost at the next
      // restart, so the caller is told which list could not be written. The
      // reason is in the message itself: the toast the user reads shows the
      // message, so a cause kept only in the data would never be seen.
      expect(answer.tag).toBe("storage_failed")
      expect(answer.message).toContain("Could not save the change")
      expect(answer.message).toContain("relays")
      expect(answer.data?.message).toContain("relays")
    } finally {
      await app.dispose()
    }
  })

  test("an unknown exit tests as unknown instead of throwing", async () => {
    const app = await start()
    try {
      const result = (await app.call("testExit", { id: "not-there" })) as {
        ok: boolean
        status: string
      }
      expect(result.ok).toBe(false)
      expect(result.status).toBe("unknown")
    } finally {
      await app.dispose()
    }
  })

  test("the command asks the terminal to open its menu", async () => {
    const app = await start()
    try {
      const command = app.commands.get("relay")
      expect(command).toBeDefined()
      await command?.execute()
      expect(app.emitted.some((entry) => entry.startsWith("menu:"))).toBe(true)
    } finally {
      await app.dispose()
    }
  })

  test("announces every change", async () => {
    const app = await start()
    try {
      await app.call("setEnabled", { enabled: true })
      expect(app.emitted.some((entry) => entry.includes("routing enabled"))).toBe(true)
    } finally {
      await app.dispose()
    }
  })
})
