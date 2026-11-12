import { describe, expect, test } from "bun:test"
import {
  isFree,
  isFreeUsageLimit,
  isSelected,
  readResponseState,
  relayRequest,
  selectModels,
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
  test("all selects every model, free or not", () => {
    expect(isSelected(freeModel, "all", [])).toBe(true)
    expect(isSelected(paidModel, "all", [])).toBe(true)
    expect(isSelected(unknownModel, "all", [])).toBe(true)
  })

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

  test("custom ignores a listed id that is not in the model list", () => {
    const custom = ["opencode/grok-code-fast", "opencode/ghost"]
    expect(isSelected(paidModel, "custom", custom)).toBe(false)
    expect(
      selectModels([freeModel, paidModel], "custom", custom).map((m) => m.id),
    ).toEqual(["opencode/grok-code-fast", "opencode/sonoma"])
  })
})

describe("selectModels", () => {
  test("flags the free models and the routed ones, and keeps the input order", () => {
    const models = [paidModel, freeModel, unknownModel]

    expect(selectModels(models, "all", [])).toEqual([
      { id: "opencode/sonoma", name: "Sonoma", free: false, routed: true },
      { id: "opencode/grok-code-fast", name: "Grok Code Fast", free: true, routed: true },
      { id: "opencode/mystery", name: "Mystery", free: false, routed: true },
    ])

    expect(selectModels(models, "free", [])).toEqual([
      { id: "opencode/sonoma", name: "Sonoma", free: false, routed: false },
      { id: "opencode/grok-code-fast", name: "Grok Code Fast", free: true, routed: true },
      { id: "opencode/mystery", name: "Mystery", free: false, routed: false },
    ])

    expect(selectModels(models, "custom", ["opencode/mystery"])).toEqual([
      { id: "opencode/sonoma", name: "Sonoma", free: false, routed: false },
      { id: "opencode/grok-code-fast", name: "Grok Code Fast", free: true, routed: false },
      { id: "opencode/mystery", name: "Mystery", free: false, routed: true },
    ])
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
      },
    })

    const relayed = relayRequest(original, target)

    expect(relayed.headers.get("x-relay-key")).toBe("access-secret")
    expect(relayed.headers.get("x-relay-target")).toBe("https://opencode.ai")
    expect(relayed.headers.get("x-relay-path")).toBe("/inference/openai/v1/models")
    expect(relayed.headers.get("x-relay-avoid")).toBeNull()
    expect(relayed.headers.get("x-relay-control")).toBeNull()
  })
})

describe("readResponseState", () => {
  test("reads the rotation from a 409", () => {
    const response = new Response("{}", {
      status: 409,
      headers: { "x-relay-rotate": "1", "x-relay-egress": "1.2.3.4" },
    })

    expect(readResponseState(response)).toEqual({ rotate: true, spent: false, egress: "1.2.3.4" })
  })

  test("a 409 without the rotate header does not rotate", () => {
    const response = new Response("{}", { status: 409 })

    expect(readResponseState(response)).toEqual({ rotate: false, spent: false })
  })

  test("reads the spent allowance from a 429", () => {
    const response = new Response("{}", { status: 429, headers: { "x-relay-egress": "1.2.3.4" } })

    expect(readResponseState(response)).toEqual({ rotate: false, spent: true, egress: "1.2.3.4" })
  })

  test("reads the egress of a plain answer", () => {
    const response = new Response("{}", { status: 200, headers: { "x-relay-egress": "5.6.7.8" } })

    expect(readResponseState(response)).toEqual({ rotate: false, spent: false, egress: "5.6.7.8" })
  })

  test("an answer without an egress reports none", () => {
    const response = new Response("{}", { status: 200 })

    expect(readResponseState(response)).toEqual({ rotate: false, spent: false })
    expect(readResponseState(response).egress).toBeUndefined()
  })
})

describe("isFreeUsageLimit", () => {
  test("spots the free usage limit error", () => {
    expect(isFreeUsageLimit('{"error":{"message":"Free usage limit reached"}}')).toBe(true)
    expect(isFreeUsageLimit("You have exceeded your free usage limit for today.")).toBe(true)
    expect(isFreeUsageLimit("free_usage_limit")).toBe(true)
  })

  test("ignores an unrelated error", () => {
    expect(isFreeUsageLimit('{"error":{"message":"Internal server error"}}')).toBe(false)
    expect(isFreeUsageLimit("")).toBe(false)
    expect(isFreeUsageLimit("rate limit exceeded")).toBe(false)
  })
})
