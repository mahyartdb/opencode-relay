import { describe, expect, test, setDefaultTimeout, setSystemTime } from "bun:test"
import net from "node:net"
import { ProxyBridge } from "../src/server/bridge.ts"
import {
  closeSocksBridges,
  socks4Connect,
  socks5Connect,
  socksBridge,
} from "../src/server/socks-bridge.ts"

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

/** Start a loopback stub, so a handshake can be completed on purpose. */
function stubServer(onData: (socket: net.Socket) => void): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer(onData)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") throw new Error("the stub has no port")
      resolve({ server, port: address.port })
    })
  })
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

describe("the SOCKS handshake hands the socket over safely", () => {
  test("a reset after the SOCKS5 handshake reaches a socket that is listening", async () => {
    const stub = await stubServer((socket) => {
      let greeted = false
      let replied = false
      socket.on("data", () => {
        if (!greeted) {
          greeted = true
          socket.write(Buffer.from([0x05, 0x00]))
          return
        }
        if (replied) return
        replied = true
        // 05 00 00 01 + 127.0.0.1:8080, ten bytes exactly.
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x1f, 0x90]))
      })
    })
    try {
      const socket = await socks5Connect(
        { version: 5, host: "127.0.0.1", port: stub.port },
        "example.com",
        443,
      )
      // link() attaches the real handlers a moment later. An RST in that
      // window emits `error` on the socket: without a listener at all Node
      // throws and the whole process dies, so this must be swallowed.
      expect(() => socket.emit("error", new Error("read ECONNRESET"))).not.toThrow()
      socket.destroy()
    } finally {
      await closeServer(stub.server)
    }
  })

  test("a reset after the SOCKS4 handshake reaches a socket that is listening", async () => {
    const stub = await stubServer((socket) => {
      socket.once("data", () => {
        // 00 5a (granted) + port and address, eight bytes exactly.
        socket.write(Buffer.concat([Buffer.from([0x00, 0x5a]), Buffer.alloc(6)]))
      })
    })
    try {
      const socket = await socks4Connect(
        { version: 4, host: "127.0.0.1", port: stub.port },
        "127.0.0.1",
        443,
      )
      expect(() => socket.emit("error", new Error("read ECONNRESET"))).not.toThrow()
      socket.destroy()
    } finally {
      await closeServer(stub.server)
    }
  })
})

/** Send one raw HTTP-proxy request and return the first response head. */
function rawProxyRequest(port: number, head: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error("the local bridge did not answer"))
    }, 5_000)
    let data = ""
    socket.on("connect", () => socket.write(head))
    socket.on("data", (chunk) => {
      data += chunk.toString("latin1")
      if (data.includes("\r\n\r\n")) {
        clearTimeout(timer)
        socket.destroy()
        resolve(data)
      }
    })
    socket.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

/** Whether a TCP connection to a loopback port is accepted. */
function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port })
    const done = (accepted: boolean) => {
      socket.destroy()
      resolve(accepted)
    }
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
  })
}

/** A SOCKS5 stub that grants every connect, so the tunnel completes. */
function grantingStub(): Promise<{ server: net.Server; port: number }> {
  return stubServer((socket) => {
    let greeted = false
    let replied = false
    socket.on("data", () => {
      if (!greeted) {
        greeted = true
        socket.write(Buffer.from([0x05, 0x00]))
        return
      }
      if (replied) return
      replied = true
      socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x1f, 0x90]))
    })
  })
}

/** Send a CONNECT for one host through a fresh bridge and report the answer. */
async function connectThrough(host: string): Promise<string> {
  const stub = await grantingStub()
  try {
    const origin = await socksBridge({ version: 5, host: "127.0.0.1", port: stub.port })
    return await rawProxyRequest(
      Number(new URL(origin).port),
      `CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`,
    )
  } finally {
    closeSocksBridges()
    await closeServer(stub.server)
  }
}

describe("the local SOCKS bridge only dials opencode.ai and its subdomains", () => {
  test("refuses a CONNECT to another host", async () => {
    try {
      const origin = await socksBridge({ version: 5, host: "127.0.0.1", port: 9 })
      const answer = await rawProxyRequest(
        Number(new URL(origin).port),
        "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n",
      )
      expect(answer.startsWith("HTTP/1.1 403")).toBe(true)
    } finally {
      closeSocksBridges()
    }
  })

  test("refuses an absolute-form request to another host", async () => {
    try {
      const origin = await socksBridge({ version: 5, host: "127.0.0.1", port: 9 })
      const answer = await rawProxyRequest(
        Number(new URL(origin).port),
        "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n",
      )
      expect(answer.startsWith("HTTP/1.1 403")).toBe(true)
    } finally {
      closeSocksBridges()
    }
  })

  test("still opens a CONNECT to opencode.ai through the SOCKS upstream", async () => {
    expect(await connectThrough("opencode.ai")).toContain("200 Connection Established")
  })

  test("opens a CONNECT to a subdomain of opencode.ai through the SOCKS upstream", async () => {
    expect(await connectThrough("api.opencode.ai")).toContain("200 Connection Established")
  })

  test("refuses a CONNECT to notopencode.ai", async () => {
    const answer = await connectThrough("notopencode.ai")
    expect(answer.startsWith("HTTP/1.1 403")).toBe(true)
  })

  test("refuses a CONNECT to opencode.ai.evil.com", async () => {
    const answer = await connectThrough("opencode.ai.evil.com")
    expect(answer.startsWith("HTTP/1.1 403")).toBe(true)
  })

  test("creating a bridge reaps one that has been idle", async () => {
    try {
      const first = await socksBridge({ version: 5, host: "127.0.0.1", port: 9 })
      const firstPort = Number(new URL(first).port)
      expect(await canConnect(firstPort)).toBe(true)
      // Let the probe's close event land, so the bridge counts as idle.
      await Bun.sleep(25)

      setSystemTime(Date.now() + 11 * 60_000)
      const second = await socksBridge({ version: 5, host: "127.0.0.1", port: 8 })
      expect(await canConnect(Number(new URL(second).port))).toBe(true)
      expect(await canConnect(firstPort)).toBe(false)
    } finally {
      setSystemTime()
      closeSocksBridges()
    }
  })
})
