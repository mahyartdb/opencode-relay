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
