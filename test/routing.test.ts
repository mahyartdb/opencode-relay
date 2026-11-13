import { describe, expect, test } from "bun:test"
import {
  BRIDGE_EXIT_HEADER,
  BRIDGE_KEY_HEADER,
  BRIDGE_TARGET_HEADER,
  exitIdOf,
  isFree,
  isFreeUsageLimit,
  isSelected,
  nextExit,
  parseRetryAfter,
  proxyIdOf,
  proxyRequest,
  readBody,
  readResponseState,
  relayIdOf,
  relayRequest,
  RELAY_ID_HEADER,
  selectModels,
  type ExitCandidate,
  type RelayTarget,
  type RoutableModel,
} from "../src/lib/routing.ts"
import type { ProxyRecord, RelayRecord } from "../src/lib/types.ts"
import { registerHooks, ROTATE_DELAY_MS } from "../src/server/hooks.ts"
import { RelayState } from "../src/server/state.ts"

const freeModel: RoutableModel = {
  id: "opencode/grok-code-fast",
  name: "Grok Code Fast",
  cost: [{ input: 0, output: 0 }],
}

const paidModel: RoutableModel = {
  id: "opencode/sonoma",
  name: "Sonoma",
  cost: [{ input: 1, output: 3 }],
}

const unknownModel: RoutableModel = {
  id: "opencode/mystery",
  name: "Mystery",
}

const target: RelayTarget = {
  url: "https://relay.example.com",
  access: "access-secret",
}

/** A candidate with only the fields the strategy reads. */
function candidate(id: string, latencyMs?: number): ExitCandidate {
  return {
    id,
    kind: id.startsWith("relay-") ? "relay" : "proxy",
    name: id,
    status: "ready",
    ...(latencyMs !== undefined ? { latencyMs } : {}),
  }
}

describe("isFree", () => {
  test("is true when every tier costs nothing", () => {
    expect(isFree(freeModel)).toBe(true)
    expect(
      isFree({
        id: "opencode/multi",
        name: "Multi",
        cost: [
          { input: 0, output: 0 },
          { input: 0, output: 0 },
        ],
      }),
    ).toBe(true)
  })

  test("is false when the model has no pricing", () => {
    expect(isFree(unknownModel)).toBe(false)
  })

  test("is false when any tier costs something", () => {
    expect(isFree(paidModel)).toBe(false)
    expect(
      isFree({
        id: "opencode/mixed",
        name: "Mixed",
        cost: [
          { input: 0, output: 0 },
          { input: 0, output: 2 },
        ],
      }),
    ).toBe(false)
  })
})

describe("isSelected", () => {
  test("free selects only the models that cost nothing", () => {
    expect(isSelected(freeModel, "free", [])).toBe(true)
    expect(isSelected(paidModel, "free", [])).toBe(false)
    expect(isSelected(unknownModel, "free", [])).toBe(false)
  })

  test("custom selects only the listed ids", () => {
    const custom = ["opencode/grok-code-fast"]
    expect(isSelected(freeModel, "custom", custom)).toBe(true)
    expect(isSelected(paidModel, "custom", custom)).toBe(false)
  })

  test("a listed paid model is still never routed", () => {
    const custom = ["opencode/sonoma"]
    expect(isSelected(paidModel, "custom", custom)).toBe(false)
  })

  test("custom ignores a listed id that is not in the model list", () => {
    const custom = ["opencode/grok-code-fast", "opencode/ghost"]
    expect(isSelected(paidModel, "custom", custom)).toBe(false)
    expect(
      selectModels([freeModel, paidModel], "custom", custom).map((model) => model.id),
    ).toEqual(["opencode/grok-code-fast", "opencode/sonoma"])
  })
})

describe("selectModels", () => {
  test("flags the free models and the routed ones, and keeps the input order", () => {
    const models = [paidModel, freeModel, unknownModel]

    expect(selectModels(models, "free", [])).toEqual([
      { id: "opencode/sonoma", name: "Sonoma", free: false, routed: false },
      { id: "opencode/grok-code-fast", name: "Grok Code Fast", free: true, routed: true },
      { id: "opencode/mystery", name: "Mystery", free: false, routed: false },
    ])

    expect(selectModels(models, "custom", ["opencode/mystery"])).toEqual([
      { id: "opencode/sonoma", name: "Sonoma", free: false, routed: false },
      { id: "opencode/grok-code-fast", name: "Grok Code Fast", free: true, routed: false },
      { id: "opencode/mystery", name: "Mystery", free: false, routed: false },
    ])
  })
})

describe("nextExit", () => {
  const all = [candidate("relay-a"), candidate("relay-b"), candidate("relay-c")]
  const usable = (skip: readonly string[] = []) => all.filter((exit) => !skip.includes(exit.id))

  test("one exit prefers the chosen one", () => {
    const pick = nextExit(usable(), all, { strategy: "fixed", activeId: "relay-b", cursor: 0 })

    expect(pick.exit?.id).toBe("relay-b")
    expect(pick.cursor).toBe(0)
  })

  test("one exit falls back to the first usable one when the chosen one cannot serve", () => {
    const pick = nextExit(usable(["relay-b"]), all, {
      strategy: "fixed",
      activeId: "relay-b",
      cursor: 0,
    })

    expect(pick.exit?.id).toBe("relay-a")
  })

  test("one exit serves nothing when nothing is usable", () => {
    const pick = nextExit([], all, { strategy: "fixed", activeId: "relay-b", cursor: 4 })

    expect(pick.exit).toBeUndefined()
    expect(pick.cursor).toBe(4)
  })

  test("round robin moves on every request and wraps", () => {
    let cursor = 0
    const picked: string[] = []
    for (let index = 0; index < 7; index += 1) {
      const pick = nextExit(usable(), all, { strategy: "round-robin", cursor })
      if (!pick.exit) throw new Error("no exit")
      picked.push(pick.exit.id)
      cursor = pick.cursor
    }

    expect(picked).toEqual(["relay-a", "relay-b", "relay-c", "relay-a", "relay-b", "relay-c", "relay-a"])
  })

  test("round robin only walks the usable list", () => {
    const list = usable(["relay-b"])
    let cursor = 0
    const picked: string[] = []
    for (let index = 0; index < 4; index += 1) {
      const pick = nextExit(list, all, { strategy: "round-robin", cursor })
      if (!pick.exit) throw new Error("no exit")
      picked.push(pick.exit.id)
      cursor = pick.cursor
    }

    expect(picked).toEqual(["relay-a", "relay-c", "relay-a", "relay-c"])
  })

  test("until exhausted serves the chosen exit while it lasts", () => {
    const pick = nextExit(usable(), all, { strategy: "exhausted", activeId: "relay-b", cursor: 0 })

    expect(pick.exit?.id).toBe("relay-b")
  })

  test("until exhausted moves to the exit after the chosen one", () => {
    const pick = nextExit(usable(["relay-b"]), all, {
      strategy: "exhausted",
      activeId: "relay-b",
      cursor: 0,
    })

    expect(pick.exit?.id).toBe("relay-c")
  })

  test("until exhausted wraps at the end of the list", () => {
    const pick = nextExit(usable(["relay-c"]), all, {
      strategy: "exhausted",
      activeId: "relay-c",
      cursor: 0,
    })

    expect(pick.exit?.id).toBe("relay-a")
  })

  test("until exhausted starts at the first usable exit when the old choice is gone", () => {
    const pick = nextExit(usable(["relay-a"]), all, {
      strategy: "exhausted",
      activeId: "relay-gone",
      cursor: 0,
    })

    expect(pick.exit?.id).toBe("relay-b")
  })

  test("fastest serves the exit with the lowest measured latency", () => {
    const list = [candidate("relay-a", 900), candidate("relay-b", 120), candidate("relay-c", 400)]

    expect(nextExit(list, list, { strategy: "fastest", cursor: 0 }).exit?.id).toBe("relay-b")
  })

  test("fastest puts exits without a measurement last", () => {
    const list = [candidate("relay-a"), candidate("relay-b", 700)]

    expect(nextExit(list, list, { strategy: "fastest", cursor: 0 }).exit?.id).toBe("relay-b")
  })

  test("fastest keeps list order on a tie", () => {
    const list = [candidate("relay-a", 300), candidate("relay-b", 300)]

    expect(nextExit(list, list, { strategy: "fastest", cursor: 0 }).exit?.id).toBe("relay-a")
  })
})

describe("relayRequest", () => {
  test("sends the request to the relay and describes the call in the headers", () => {
    const original = new Request("https://opencode.ai/inference/openai/v1/chat/completions?beta=true", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })

    const relayed = relayRequest(original, target)

    expect(relayed.url).toBe("https://relay.example.com/")
    expect(relayed.method).toBe("POST")
    expect(relayed.redirect).toBe("manual")
    expect(relayed.headers.get("x-relay-target")).toBe("https://opencode.ai")
    expect(relayed.headers.get("x-relay-path")).toBe("/inference/openai/v1/chat/completions?beta=true")
    expect(relayed.headers.get("x-relay-key")).toBe("access-secret")
    expect(relayed.headers.get("x-relay-avoid")).toBeNull()
    expect(relayed.headers.get("content-type")).toBe("application/json")
  })

  test("normalises the relay url", () => {
    const original = new Request("https://opencode.ai/inference/openai/v1/models")

    expect(relayRequest(original, { url: "relay.example.com/", access: "k" }).url).toBe(
      "https://relay.example.com/",
    )
    expect(relayRequest(original, { url: "relay.example.com", access: "k" }).url).toBe(
      "https://relay.example.com/",
    )
    expect(relayRequest(original, { url: "https://relay.example.com/", access: "k" }).url).toBe(
      "https://relay.example.com/",
    )
  })

  test("drops the hop-by-hop headers", () => {
    const original = new Request("https://opencode.ai/inference/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        host: "opencode.ai",
        "content-length": "2",
        connection: "keep-alive",
        "keep-alive": "timeout=5",
        "transfer-encoding": "chunked",
        "proxy-authorization": "Basic abc",
        "proxy-connection": "keep-alive",
        te: "trailers",
        trailer: "x-trailer",
        upgrade: "websocket",
        authorization: "Bearer token",
      },
      body: "{}",
    })

    const relayed = relayRequest(original, target)

    for (const header of [
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
    ]) {
      expect(relayed.headers.get(header)).toBeNull()
    }
    expect(relayed.headers.get("authorization")).toBe("Bearer token")
  })

  test("sends the avoided addresses only when there are some", () => {
    const original = new Request("https://opencode.ai/inference/openai/v1/models")

    expect(relayRequest(original, { ...target, avoid: [] }).headers.get("x-relay-avoid")).toBeNull()
    expect(
      relayRequest(original, { ...target, avoid: ["1.2.3.4"] }).headers.get("x-relay-avoid"),
    ).toBe("1.2.3.4")
    expect(
      relayRequest(original, { ...target, avoid: ["1.2.3.4", "5.6.7.8"] }).headers.get("x-relay-avoid"),
    ).toBe("1.2.3.4,5.6.7.8")
  })

  test("keeps the method and the body", async () => {
    const payload = JSON.stringify({ model: "opencode/grok-code-fast", stream: true })
    const original = new Request("https://opencode.ai/inference/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    })

    const relayed = relayRequest(original, target)

    expect(relayed.method).toBe("POST")
    expect(await relayed.text()).toBe(payload)
  })

  test("replaces the relay headers the caller already sent", () => {
    const original = new Request("https://opencode.ai/inference/openai/v1/models", {
      headers: {
        "x-relay-key": "stale-key",
        "x-relay-target": "https://evil.example",
        "x-relay-path": "/stale",
        "x-relay-avoid": "9.9.9.9",
        "x-relay-control": "ping",
        "x-bridge-exit": "stale-proxy",
        "x-bridge-key": "stale-bridge",
        "x-bridge-target": "https://evil.example",
      },
    })

    const relayed = relayRequest(original, target)

    expect(relayed.headers.get("x-relay-key")).toBe("access-secret")
    expect(relayed.headers.get("x-relay-target")).toBe("https://opencode.ai")
    expect(relayed.headers.get("x-relay-path")).toBe("/inference/openai/v1/models")
    expect(relayed.headers.get("x-relay-avoid")).toBeNull()
    expect(relayed.headers.get("x-relay-control")).toBeNull()
    expect(relayed.headers.get("x-bridge-exit")).toBeNull()
    expect(relayed.headers.get("x-bridge-key")).toBeNull()
    expect(relayed.headers.get("x-bridge-target")).toBeNull()
  })
})

describe("proxyRequest", () => {
  const bridge = {
    bridge: "http://127.0.0.1:43121",
    key: "bridge-secret",
    id: "proxy-1",
  }

  test("points the request at loopback and names the target and the proxy", () => {
    const original = new Request("https://opencode.ai/inference/openai/v1/models?x=1", {
      headers: { authorization: "Bearer token" },
    })

    const proxied = proxyRequest(original, bridge)

    expect(proxied.url).toBe("http://127.0.0.1:43121/")
    expect(proxied.headers.get(BRIDGE_KEY_HEADER)).toBe("bridge-secret")
    expect(proxied.headers.get(BRIDGE_EXIT_HEADER)).toBe("proxy-1")
    expect(proxied.headers.get(BRIDGE_TARGET_HEADER)).toBe(
      "https://opencode.ai/inference/openai/v1/models?x=1",
    )
    expect(proxied.headers.get("authorization")).toBe("Bearer token")
    expect(proxied.redirect).toBe("manual")
    expect(proxyIdOf(proxied)).toBe("proxy-1")
    expect(relayIdOf(proxied)).toBeUndefined()
    expect(exitIdOf(proxied)).toBe("proxy-1")
  })
})

describe("the relay marker", () => {
  test("marks the request with the relay that serves it", () => {
    const request = new Request("https://opencode.ai/inference/openai/v1/models")
    const marked = relayRequest(request, { ...target, id: "relay-1" })

    expect(marked.headers.get(RELAY_ID_HEADER)).toBe("relay-1")
    expect(relayIdOf(marked)).toBe("relay-1")
    expect(exitIdOf(marked)).toBe("relay-1")
  })

  test("replaces a marker the caller brought along", () => {
    const request = new Request("https://opencode.ai/inference/openai/v1/models", {
      headers: { "x-relay-id": "stale", "x-relay-key": "stale-key" },
    })
    const marked = relayRequest(request, { ...target, id: "relay-2" })

    expect(marked.headers.get(RELAY_ID_HEADER)).toBe("relay-2")
    expect(marked.headers.get("x-relay-key")).toBe("access-secret")
  })

  test("an unmarked request has no exit", () => {
    const request = new Request("https://opencode.ai/inference/openai/v1/models")

    expect(relayIdOf(request)).toBeUndefined()
    expect(proxyIdOf(request)).toBeUndefined()
    expect(exitIdOf(request)).toBeUndefined()
  })
})

describe("readResponseState", () => {
  test("reads the rotation and the egress from a 409", () => {
    const response = new Response("{}", {
      status: 409,
      headers: {
        "x-relay-rotate": "1",
        "x-relay-egress": "1.2.3.4",
        "x-relay-instance": "i-1",
        "x-relay-runtime": "bun",
      },
    })

    expect(readResponseState(response)).toEqual({
      rotate: true,
      reachedExit: true,
      egress: "1.2.3.4",
      instance: "i-1",
      runtime: "bun",
    })
  })

  test("a 409 without the rotate header does not rotate", () => {
    const response = new Response("{}", { status: 409 })

    expect(readResponseState(response)).toEqual({ rotate: false, reachedExit: false })
  })

  test("a 429 is not judged here: only the body and a canary can tell", () => {
    const response = new Response("{}", { status: 429, headers: { "x-relay-egress": "1.2.3.4" } })

    expect(readResponseState(response)).toEqual({
      rotate: false,
      reachedExit: true,
      egress: "1.2.3.4",
    })
  })

  test("an answer without exit headers did not reach an exit", () => {
    const response = new Response("{}", { status: 502 })

    expect(readResponseState(response)).toEqual({ rotate: false, reachedExit: false })
  })
})

describe("isFreeUsageLimit", () => {
  test("spots the free usage limit error", () => {
    expect(isFreeUsageLimit('{"error":{"message":"Free usage limit reached"}}')).toBe(true)
    expect(isFreeUsageLimit("You have exceeded your free usage limit for today.")).toBe(true)
    expect(isFreeUsageLimit("free_usage_limit")).toBe(true)
    expect(isFreeUsageLimit('{"error":{"type":"FreeUsageLimitError"}}')).toBe(true)
  })

  test("ignores an unrelated error", () => {
    expect(isFreeUsageLimit('{"error":{"message":"Internal server error"}}')).toBe(false)
    expect(isFreeUsageLimit("")).toBe(false)
    expect(isFreeUsageLimit("rate limit exceeded")).toBe(false)
  })
})

describe("parseRetryAfter", () => {
  test("reads seconds", () => {
    expect(parseRetryAfter("120")).toBe(120_000)
    expect(parseRetryAfter("0")).toBe(0)
  })

  test("reads an HTTP date", () => {
    const now = Date.parse("2026-01-01T00:00:00Z")
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:10:00 GMT", now)).toBe(600_000)
  })

  test("a missing or unreadable value means the provider did not say", () => {
    expect(parseRetryAfter(null)).toBe(0)
    expect(parseRetryAfter("soon")).toBe(0)
    expect(parseRetryAfter("-5")).toBe(0)
  })
})

describe("readBody", () => {
  test("reads the body from a copy and leaves the answer usable", async () => {
    const response = new Response('{"hello":"world"}')

    const body = await readBody(response)

    expect(body).toBe('{"hello":"world"}')
    expect(await response.text()).toBe('{"hello":"world"}')
  })

  test("cuts a long body", async () => {
    const response = new Response("x".repeat(9000))

    const body = await readBody(response, 2000, 4000)

    expect(body?.length).toBe(4000)
  })
})

/**
 * The hooks decide what a real request and a real answer do to an exit. These
 * tests drive them with the smallest context that can register a session hook:
 * the network is never touched, and every state transition is observed.
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

/** A relay that only needs its health to be interesting. */
function relay(id: string): RelayRecord {
  return {
    kind: "relay",
    id,
    name: id,
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

/** A proxy that only needs its health to be interesting. */
function proxy(id: string): ProxyRecord {
  return {
    kind: "proxy",
    id,
    name: id,
    url: `http://${id}.example.com:8080`,
    enabled: true,
    status: "untested",
    createdAt: Date.now(),
  }
}

type HookHandler = (input: any) => Promise<void> | void

/** Register the real hooks against a real state and no outside world. */
async function makeHooks(canary: () => Promise<string> = async () => "inconclusive") {
  const state = new RelayState(memoryStorage() as never)
  await state.load()
  await state.setEnabled(true)
  const handlers = new Map<string, HookHandler>()
  await registerHooks(
    {
      session: {
        hook: async (name: string, callback: HookHandler) => {
          handlers.set(name, callback)
          return { dispose: async () => {} }
        },
      },
    } as never,
    {
      state,
      catalog: {
        list: async () => [freeModel],
        resolve: (models: readonly RoutableModel[], id: string) =>
          models.find((model) => model.id === id) ?? { id, name: id },
      } as never,
      bridge: { ready: true, origin: "http://127.0.0.1:1", key: "bridge-key" } as never,
      tester: { canary } as never,
    },
  )
  return { state, hooks: handlers }
}

/** A state with the named exits ready to serve. */
async function setup(
  relays: readonly string[] = ["relay-1"],
  proxies: readonly string[] = [],
  canary?: () => Promise<string>,
) {
  const made = await makeHooks(canary)
  for (const id of relays) {
    await made.state.addRelay(relay(id))
    await made.state.setHealth(id, { status: "ready" })
  }
  for (const id of proxies) {
    await made.state.addProxy(proxy(id))
    await made.state.setHealth(id, { status: "ready" })
  }
  return made
}

/** A request as the plugin would send it through one relay. */
function requestFor(id: string): Request {
  return relayRequest(new Request("https://opencode.ai/inference/openai/v1/models"), {
    url: "https://relay.example.com",
    access: "test-access",
    id,
  })
}

/** A request as the plugin would send it through one proxy. */
function proxiedFor(id: string): Request {
  return proxyRequest(new Request("https://opencode.ai/inference/openai/v1/models"), {
    bridge: "http://127.0.0.1:1",
    key: "bridge-key",
    id,
  })
}

function answerInput(
  sessionID: string,
  request: Request,
  status: number,
  headers: Record<string, string> = {},
  body = "{}",
) {
  const nullBody = status === 204 || status === 205
  return {
    sessionID,
    model: { id: freeModel.id, providerID: "opencode" },
    request,
    response: new Response(nullBody ? null : body, { status, headers }),
  }
}

function responseInput(
  sessionID: string,
  exitId: string,
  status: number,
  headers: Record<string, string> = {},
) {
  return answerInput(sessionID, requestFor(exitId), status, headers)
}

function retryInput(sessionID: string, status?: number, message?: string) {
  return {
    sessionID,
    model: { id: freeModel.id, providerID: "opencode" },
    error: {
      ...(status !== undefined ? { status } : {}),
      ...(message !== undefined ? { message } : {}),
    },
    attempt: 1,
    decision: { retry: false } as { retry: boolean; delay?: number },
  }
}

describe("the request hook on a provider that merely calls itself opencode", () => {
  test("leaves a request for another host unchanged, credentials included", async () => {
    const { state, hooks } = await setup()
    const original = new Request("https://gateway.example.com/inference/openai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer provider-key", "content-type": "application/json" },
      body: "{}",
    })
    const input = {
      sessionID: "other-host",
      model: { id: freeModel.id, providerID: "opencode" },
      request: original,
    }

    await hooks.get("http.request")?.(input as never)

    expect(input.request.url).toBe(original.url)
    expect(input.request.headers.get("authorization")).toBe("Bearer provider-key")
    expect(input.request.headers.get("x-relay-id")).toBeNull()
    expect(state.lastDecision()?.routed).toBe(false)
    expect(state.lastDecision()?.reason).toContain("opencode.ai")
  })

  test("reports a request whose URL cannot be read instead of guessing", async () => {
    const { state, hooks } = await setup()
    const input = {
      sessionID: "no-url",
      model: { id: freeModel.id, providerID: "opencode" },
      request: undefined,
    }

    await hooks.get("http.request")?.(input as never)

    expect(input.request).toBeUndefined()
    expect(state.lastDecision()?.routed).toBe(false)
    expect(state.lastDecision()?.reason).toContain("URL")
  })

  test("still routes a request addressed to an upstream subdomain", async () => {
    const { hooks } = await setup()
    const input = {
      sessionID: "upstream",
      model: { id: freeModel.id, providerID: "opencode" },
      request: new Request("https://api.opencode.ai/inference/openai/v1/models"),
    }

    await hooks.get("http.request")?.(input as never)

    expect(input.request.headers.get("x-relay-id")).toBe("relay-1")
  })
})

describe("the response and retry hooks on another provider", () => {
  test("leave the exit alone when the provider id is not opencode", async () => {
    const { state, hooks } = await setup(["relay-1", "relay-2"])
    state.noteRelayed("other-provider", freeModel.id, "relay-1")
    const response = responseInput("other-provider", "relay-1", 502)
    response.model.providerID = "polygate"

    await hooks.get("http.response")?.(response as never)

    expect(state.statsFor("relay-1").failed).toBe(0)
    expect(state.exit("relay-1")?.status).toBe("ready")
    expect(state.failureFor("other-provider", freeModel.id)).toBeUndefined()

    const retry = retryInput("other-provider", 502)
    retry.model.providerID = "polygate"
    await hooks.get("retry")?.(retry as never)

    expect(retry.decision).toEqual({ retry: false })
  })
})

describe("the retry hook on 401 and 403", () => {
  for (const status of [401, 403]) {
    test(`${status} retries through a backup exit`, async () => {
      const { state, hooks } = await setup(["relay-1", "relay-2"])
      state.noteRelayed("blocked", freeModel.id, "relay-1")

      await hooks.get("http.response")?.(responseInput("blocked", "relay-1", status) as never)

      expect(state.exit("relay-1")?.status).toBe("blocked")
      expect(state.statsFor("relay-1").failed).toBe(0)
      // The response hook rests the exit once. The retry hook must not rest it
      // again, or the cooldown would double.
      expect(state.failureCount("relay-1")).toBe(1)

      const retry = retryInput("blocked", status)
      await hooks.get("retry")?.(retry as never)

      expect(retry.decision).toEqual({ retry: true, delay: ROTATE_DELAY_MS })
      expect(state.statsFor("relay-1").failed).toBe(0)
      expect(state.failureCount("relay-1")).toBe(1)
    })

    test(`${status} retries direct when no exit remains and direct is allowed`, async () => {
      const { state, hooks } = await setup(["relay-1"])
      state.noteRelayed("blocked-direct", freeModel.id, "relay-1")

      await hooks.get("http.response")?.(
        responseInput("blocked-direct", "relay-1", status) as never,
      )

      const retry = retryInput("blocked-direct", status)
      await hooks.get("retry")?.(retry as never)

      expect(retry.decision).toEqual({ retry: true, delay: ROTATE_DELAY_MS })
    })

    test(`${status} is not retried when no exit remains and direct is forbidden`, async () => {
      const { state, hooks } = await setup(["relay-1"])
      await state.setDirect("never")
      state.noteRelayed("blocked-never", freeModel.id, "relay-1")

      await hooks.get("http.response")?.(
        responseInput("blocked-never", "relay-1", status) as never,
      )

      const retry = retryInput("blocked-never", status)
      await hooks.get("retry")?.(retry as never)

      expect(retry.decision).toEqual({ retry: false })
    })
  }
})

describe("the response and retry hooks on an unrecognised 4xx", () => {
  for (const status of [404, 407, 408, 425, 451]) {
    test(`${status} is an exit fault: retired once and retried`, async () => {
      const { state, hooks } = await setup(["relay-1", "relay-2"])
      state.noteRelayed("exit-fault", freeModel.id, "relay-1")

      await hooks.get("http.response")?.(responseInput("exit-fault", "relay-1", status) as never)

      expect(state.exit("relay-1")?.status).toBe("bad")
      expect(state.statsFor("relay-1").failed).toBe(1)
      expect(state.failureCount("relay-1")).toBe(1)
      expect(state.failureFor("exit-fault", freeModel.id)?.kind).toBe("server")

      const retry = retryInput("exit-fault", status)
      await hooks.get("retry")?.(retry as never)

      expect(retry.decision).toEqual({ retry: true, delay: ROTATE_DELAY_MS })
      expect(state.statsFor("relay-1").failed).toBe(1)
      expect(state.failureCount("relay-1")).toBe(1)
    })
  }

  test("is not retried when no exit remains and direct is forbidden", async () => {
    const { state, hooks } = await setup(["relay-1"])
    await state.setDirect("never")
    state.noteRelayed("exit-fault-never", freeModel.id, "relay-1")

    await hooks.get("http.response")?.(
      responseInput("exit-fault-never", "relay-1", 404) as never,
    )

    const retry = retryInput("exit-fault-never", 404)
    await hooks.get("retry")?.(retry as never)

    expect(retry.decision).toEqual({ retry: false })
    expect(state.failureCount("relay-1")).toBe(1)
  })

  for (const status of [400, 422]) {
    test(`${status} is request-specific: recorded but neither retired nor retried`, async () => {
      const { state, hooks } = await setup(["relay-1", "relay-2"])
      state.noteRelayed("request-fault", freeModel.id, "relay-1")

      await hooks.get("http.response")?.(
        responseInput("request-fault", "relay-1", status) as never,
      )

      expect(state.statsFor("relay-1").failed).toBe(1)
      expect(state.exit("relay-1")?.status).toBe("ready")
      expect(state.coolingExits()).toEqual([])
      expect(state.failureFor("request-fault", freeModel.id)?.kind).toBe("refused")

      const retry = retryInput("request-fault", status)
      await hooks.get("retry")?.(retry as never)

      expect(retry.decision).toEqual({ retry: false })
      expect(state.statsFor("relay-1").failed).toBe(1)
    })
  }
})

describe("what counts as a successful answer", () => {
  const rejected: readonly (readonly [string, number, Record<string, string>])[] = [
    ["a 302 redirect", 302, {}],
    ["a 204 with no body", 204, {}],
    [
      "an HTML page",
      200,
      { "content-type": "text/html; charset=utf-8", "x-relay-instance": "i-1" },
    ],
    ["an answer that never reached the relay", 200, { "content-type": "application/json" }],
  ]

  for (const [label, status, headers] of rejected) {
    test(`${label} is not a success`, async () => {
      const { state, hooks } = await setup()

      await hooks.get("http.response")?.(
        answerInput("not-success", requestFor("relay-1"), status, headers) as never,
      )

      expect(state.statsFor("relay-1").ok).toBe(0)
      expect(state.statsFor("relay-1").failed).toBe(1)
      expect(state.exit("relay-1")?.status).toBe("bad")
      expect(state.failureFor("not-success", freeModel.id)?.kind).toBe("server")
    })
  }

  test("a rejected answer is retried through another exit, marked once", async () => {
    const { state, hooks } = await setup(["relay-1", "relay-2"])
    state.noteRelayed("rejected", freeModel.id, "relay-1")

    await hooks.get("http.response")?.(responseInput("rejected", "relay-1", 302) as never)

    const retry = retryInput("rejected", 302)
    await hooks.get("retry")?.(retry as never)

    expect(retry.decision).toEqual({ retry: true, delay: ROTATE_DELAY_MS })
    expect(state.statsFor("relay-1").failed).toBe(1)
  })

  test("a JSON 200 through a relay is a success", async () => {
    const { state, hooks } = await setup()

    await hooks.get("http.response")?.(
      responseInput("json-relay", "relay-1", 200, {
        "content-type": "application/json",
        "x-relay-instance": "i-1",
      }) as never,
    )

    expect(state.statsFor("relay-1").ok).toBe(1)
    expect(state.exit("relay-1")?.status).toBe("ready")
    expect(state.failureFor("json-relay", freeModel.id)).toBeUndefined()
  })

  test("an SSE 200 through a relay is a success", async () => {
    const { state, hooks } = await setup()

    await hooks.get("http.response")?.(
      responseInput("sse-relay", "relay-1", 200, {
        "content-type": "text/event-stream",
        "x-relay-runtime": "bun",
      }) as never,
    )

    expect(state.statsFor("relay-1").ok).toBe(1)
    expect(state.exit("relay-1")?.status).toBe("ready")
  })

  test("a JSON 200 through a proxy is a success even without relay headers", async () => {
    const { state, hooks } = await setup([], ["proxy-1"])

    await hooks.get("http.response")?.(
      answerInput("json-proxy", proxiedFor("proxy-1"), 200, {
        "content-type": "application/json",
      }) as never,
    )

    expect(state.statsFor("proxy-1").ok).toBe(1)
    expect(state.exit("proxy-1")?.status).toBe("ready")
  })

  test("an SSE 200 through a proxy is a success even without relay headers", async () => {
    const { state, hooks } = await setup([], ["proxy-1"])

    await hooks.get("http.response")?.(
      answerInput("sse-proxy", proxiedFor("proxy-1"), 200, {
        "content-type": "text/event-stream",
      }) as never,
    )

    expect(state.statsFor("proxy-1").ok).toBe(1)
    expect(state.exit("proxy-1")?.status).toBe("ready")
  })
})

describe("the retry hook on 5xx", () => {
  test("counts one failure, not one per hook", async () => {
    const { state, hooks } = await setup(["relay-1", "relay-2"])
    state.noteRelayed("server-error", freeModel.id, "relay-1")

    await hooks.get("http.response")?.(responseInput("server-error", "relay-1", 502) as never)

    expect(state.statsFor("relay-1").failed).toBe(1)
    expect(state.failureCount("relay-1")).toBe(1)

    const retry = retryInput("server-error", 502, "Upstream request failed")
    await hooks.get("retry")?.(retry as never)

    expect(retry.decision).toEqual({ retry: true, delay: ROTATE_DELAY_MS })
    expect(state.statsFor("relay-1").failed).toBe(1)
    expect(state.failureCount("relay-1")).toBe(1)
  })

  test("still marks a 5xx the response hook never saw", async () => {
    const { state, hooks } = await setup(["relay-1", "relay-2"])
    state.noteRelayed("server-only", freeModel.id, "relay-1")

    const retry = retryInput("server-only", 503, "Service unavailable")
    await hooks.get("retry")?.(retry as never)

    expect(retry.decision).toEqual({ retry: true, delay: ROTATE_DELAY_MS })
    expect(state.statsFor("relay-1").failed).toBe(0)
    expect(state.failureCount("relay-1")).toBe(1)
    expect(state.exit("relay-1")?.status).toBe("bad")
  })

  test("is not retried when no exit remains and direct is forbidden", async () => {
    const { state, hooks } = await setup(["relay-1"])
    await state.setDirect("never")
    state.noteRelayed("server-never", freeModel.id, "relay-1")

    await hooks.get("http.response")?.(responseInput("server-never", "relay-1", 500) as never)

    const retry = retryInput("server-never", 500)
    await hooks.get("retry")?.(retry as never)

    expect(retry.decision).toEqual({ retry: false })
    expect(state.failureCount("relay-1")).toBe(1)
  })

  test("is retried direct when no exit remains but direct is allowed", async () => {
    const { state, hooks } = await setup(["relay-1"])
    state.noteRelayed("server-direct", freeModel.id, "relay-1")

    await hooks.get("http.response")?.(responseInput("server-direct", "relay-1", 500) as never)

    const retry = retryInput("server-direct", 500)
    await hooks.get("retry")?.(retry as never)

    expect(retry.decision).toEqual({ retry: true, delay: ROTATE_DELAY_MS })
  })

  test("a transport error is still marked once and retried", async () => {
    const { state, hooks } = await setup(["relay-1", "relay-2"])
    state.noteRelayed("transport", freeModel.id, "relay-1")

    const retry = retryInput("transport", undefined, "fetch failed")
    await hooks.get("retry")?.(retry as never)

    expect(retry.decision).toEqual({ retry: true, delay: ROTATE_DELAY_MS })
    expect(state.failureCount("relay-1")).toBe(1)
    expect(state.exit("relay-1")?.status).toBe("unreachable")
  })

  test("a transport error with no exit left and direct forbidden is not retried", async () => {
    const { state, hooks } = await setup(["relay-1"])
    await state.setDirect("never")
    state.noteRelayed("transport-never", freeModel.id, "relay-1")

    const retry = retryInput("transport-never", undefined, "fetch failed")
    await hooks.get("retry")?.(retry as never)

    expect(retry.decision).toEqual({ retry: false })
    // The transport failure is still on record: leaving the decision alone
    // must not lose the mark the request hook would otherwise report.
    expect(state.failureCount("relay-1")).toBe(1)
    expect(state.exit("relay-1")?.status).toBe("unreachable")
  })
})

describe("the retry hook on a 429 free-allowance answer with no exit left", () => {
  function freeLimitAnswer(sessionID: string) {
    return answerInput(
      sessionID,
      requestFor("relay-1"),
      429,
      { "x-relay-egress": "203.0.113.12" },
      '{"error":{"message":"Free usage limit reached"}}',
    )
  }

  test("falls back to direct when direct is allowed", async () => {
    const { state, hooks } = await setup(["relay-1"], [], async () => "spent")
    state.noteRelayed("free-direct", freeModel.id, "relay-1")

    await hooks.get("http.response")?.(freeLimitAnswer("free-direct") as never)

    expect(state.exit("relay-1")?.status).toBe("exhausted")
    expect(state.failureFor("free-direct", freeModel.id)?.kind).toBe("exhausted")

    const retry = retryInput("free-direct", 429)
    await hooks.get("retry")?.(retry as never)

    expect(retry.decision).toEqual({ retry: true, delay: ROTATE_DELAY_MS })
  })

  test("is not retried when direct is forbidden", async () => {
    const { state, hooks } = await setup(["relay-1"], [], async () => "spent")
    await state.setDirect("never")
    state.noteRelayed("free-never", freeModel.id, "relay-1")

    await hooks.get("http.response")?.(freeLimitAnswer("free-never") as never)

    expect(state.exit("relay-1")?.status).toBe("exhausted")

    const retry = retryInput("free-never", 429)
    await hooks.get("retry")?.(retry as never)

    expect(retry.decision).toEqual({ retry: false })
    expect(state.exit("relay-1")?.status).toBe("exhausted")
  })
})

describe("the retry hook on a rotate 409 with one exit", () => {
  test("falls back to direct when direct is allowed", async () => {
    const { state, hooks } = await setup(["relay-1"])
    state.noteRelayed("rotate-direct", freeModel.id, "relay-1")

    await hooks.get("http.response")?.(
      responseInput("rotate-direct", "relay-1", 409, {
        "x-relay-rotate": "1",
        "x-relay-egress": "203.0.113.9",
      }) as never,
    )

    expect(state.exit("relay-1")?.status).toBe("exhausted")

    const retry = retryInput("rotate-direct", 409)
    await hooks.get("retry")?.(retry as never)

    expect(retry.decision).toEqual({ retry: true, delay: ROTATE_DELAY_MS })
  })

  test("is not retried when direct is forbidden", async () => {
    const { state, hooks } = await setup(["relay-1"])
    await state.setDirect("never")
    state.noteRelayed("rotate-never", freeModel.id, "relay-1")

    await hooks.get("http.response")?.(
      responseInput("rotate-never", "relay-1", 409, {
        "x-relay-rotate": "1",
        "x-relay-egress": "203.0.113.10",
      }) as never,
    )

    const retry = retryInput("rotate-never", 409)
    await hooks.get("retry")?.(retry as never)

    expect(retry.decision).toEqual({ retry: false })
  })

  test("still moves to the backup exit when one is available", async () => {
    const { state, hooks } = await setup(["relay-1", "relay-2"])
    state.noteRelayed("rotate-backup", freeModel.id, "relay-1")

    await hooks.get("http.response")?.(
      responseInput("rotate-backup", "relay-1", 409, {
        "x-relay-rotate": "1",
        "x-relay-egress": "203.0.113.11",
      }) as never,
    )

    const retry = retryInput("rotate-backup", 409)
    await hooks.get("retry")?.(retry as never)

    expect(retry.decision).toEqual({ retry: true, delay: ROTATE_DELAY_MS })
  })
})
