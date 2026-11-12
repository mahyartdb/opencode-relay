import { describe, expect, test, setDefaultTimeout } from "bun:test"
import { ProxyBridge } from "../src/server/bridge.ts"

setDefaultTimeout(30_000)

const EXIT = "known-exit"

/** proxyUrl: a known exit points at port 9 (nothing listens), anything else is gone. */
function makeBridge(): ProxyBridge {
  return new ProxyBridge({
    proxyUrl: (id) => (id === EXIT ? "http://127.0.0.1:9" : undefined),
  })
}

async function send(
  bridge: ProxyBridge,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const response = await fetch(bridge.origin, { headers })
  return { status: response.status, body: await response.text() }
}

describe("ProxyBridge", () => {
  test("refuses a request without x-bridge-key", async () => {
    const bridge = makeBridge()
    try {
      bridge.start()
      const result = await send(bridge, {
        "x-bridge-exit": EXIT,
        "x-bridge-target": "https://opencode.ai/inference/v1/models",
      })
      expect(result.status).toBe(401)
    } finally {
      bridge.stop()
    }
  })

  test("refuses a wrong key of the same length", async () => {
    const bridge = makeBridge()
    try {
      bridge.start()
      const result = await send(bridge, {
        "x-bridge-key": "0".repeat(bridge.key.length),
        "x-bridge-exit": EXIT,
        "x-bridge-target": "https://opencode.ai/inference/v1/models",
      })
      expect(result.status).toBe(401)
    } finally {
      bridge.stop()
    }
  })

  test("forbids a target outside opencode.ai", async () => {
    const bridge = makeBridge()
    try {
      bridge.start()
      const result = await send(bridge, {
        "x-bridge-key": bridge.key,
        "x-bridge-exit": EXIT,
        "x-bridge-target": "https://example.com/",
      })
      expect(result.status).toBe(403)
    } finally {
      bridge.stop()
    }
  })

  test("forbids a plain-http opencode.ai target", async () => {
    const bridge = makeBridge()
    try {
      bridge.start()
      const result = await send(bridge, {
        "x-bridge-key": bridge.key,
        "x-bridge-exit": EXIT,
        "x-bridge-target": "http://opencode.ai/",
      })
      expect(result.status).toBe(403)
    } finally {
      bridge.stop()
    }
  })

  test("answers 502 when the configured proxy cannot carry the request", async () => {
    const bridge = makeBridge()
    try {
      bridge.start()
      const result = await send(bridge, {
        "x-bridge-key": bridge.key,
        "x-bridge-exit": EXIT,
        "x-bridge-target": "https://opencode.ai/inference/v1/models",
      })
      expect(result.status).toBe(502)
    } finally {
      bridge.stop()
    }
  })

  test("answers 409 when the exit is unknown", async () => {
    const bridge = makeBridge()
    try {
      bridge.start()
      const result = await send(bridge, {
        "x-bridge-key": bridge.key,
        "x-bridge-exit": "no-such-exit",
        "x-bridge-target": "https://opencode.ai/inference/v1/models",
      })
      expect(result.status).toBe(409)
    } finally {
      bridge.stop()
    }
  })

  test("tracks ready across start and stop", async () => {
    const bridge = makeBridge()
    expect(bridge.ready).toBe(false)
    try {
      bridge.start()
      expect(bridge.ready).toBe(true)
    } finally {
      bridge.stop()
    }
    expect(bridge.ready).toBe(false)
  })
})
