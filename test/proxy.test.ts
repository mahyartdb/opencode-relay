import { describe, expect, test } from "bun:test"
import { parseProxyList, parseProxyUrl, proxyKey, redactProxyToken } from "../src/lib/proxy.ts"
import { readBody } from "../src/lib/routing.ts"

describe("parseProxyList", () => {
  test("reads one proxy per line in the shapes people actually paste", () => {
    const parsed = parseProxyList(`
      1.2.3.4:8080
      socks5://5.6.7.8:1080
      user:pass@9.9.9.9:3128
      http://alice:secret@proxy.example.com:8000
    `)

    expect(parsed.invalid).toEqual([])
    expect(parsed.proxies.map((proxy) => proxy.url)).toEqual([
      "http://1.2.3.4:8080",
      "socks5://5.6.7.8:1080",
      "http://user:pass@9.9.9.9:3128",
      "http://alice:secret@proxy.example.com:8000",
    ])
  })

  test("reads several proxies on one line", () => {
    const parsed = parseProxyList("1.2.3.4:8080, 5.6.7.8:8081;9.9.9.9:8082 8.8.8.8:8083")

    expect(parsed.invalid).toEqual([])
    expect(parsed.proxies.map((proxy) => proxy.port)).toEqual([8080, 8081, 8082, 8083])
  })

  test("reads host:port:user:pass", () => {
    const proxy = parseProxyUrl("1.2.3.4:8080:bob:hunter2")

    expect(proxy?.url).toBe("http://bob:hunter2@1.2.3.4:8080")
    expect(proxy?.username).toBe("bob")
    expect(proxy?.password).toBe("hunter2")
  })

  test("reads host:port:user with no password", () => {
    const proxy = parseProxyUrl("1.2.3.4:8080:bob")

    expect(proxy?.url).toBe("http://bob@1.2.3.4:8080")
    expect(proxy?.password).toBeUndefined()
  })

  test("never alters a password that ends in a dot", () => {
    const proxy = parseProxyUrl("1.2.3.4:8080:user:pass.")

    expect(proxy?.password).toBe("pass.")
    expect(proxy?.url).toBe("http://user:pass.@1.2.3.4:8080")

    // Prose around an address can no longer be silently repaired either: the
    // dot may belong to the password, so the entry is refused with a reason
    // instead of being edited into a different credential.
    const prose = parseProxyList("use 1.2.3.4:8080.")
    expect(prose.proxies).toEqual([])
    expect(prose.invalid.map((entry) => entry.reason)).toEqual(["expected host:port", "expected host:port"])
  })

  test("still strips list punctuation around a bare address", () => {
    expect(parseProxyUrl("1.2.3.4:8080,")?.port).toBe(8080)
    expect(parseProxyUrl("<1.2.3.4:8080>")?.port).toBe(8080)
  })

  test("reads host:port@user:pass in either order", () => {
    expect(parseProxyUrl("1.2.3.4:8080@bob:secret")?.url).toBe(
      "http://bob:secret@1.2.3.4:8080",
    )
    expect(parseProxyUrl("bob:secret@1.2.3.4:8080")?.url).toBe(
      "http://bob:secret@1.2.3.4:8080",
    )
  })

  test("keeps a separator inside a password instead of splitting the token", () => {
    const parsed = parseProxyList(`
      socks5://user:p;ss@host:1080
    `)

    expect(parsed.invalid).toEqual([])
    expect(parsed.proxies).toHaveLength(1)
    expect(parsed.proxies[0]?.username).toBe("user")
    expect(parsed.proxies[0]?.password).toBe("p;ss")
    expect(parsed.proxies[0]?.url).toBe("socks5://user:p%3Bss@host:1080")
  })

  test("keeps a comma inside a password", () => {
    const proxy = parseProxyUrl("http://user:p,ss@host:8080")

    expect(proxy?.url).toBe("http://user:p%2Css@host:8080")
    expect(proxy?.password).toBe("p,ss")
  })

  test("splits scheme'd addresses without credentials at separators", () => {
    const comma = parseProxyList("http://1.2.3.4:8080,http://5.6.7.8:8080")

    expect(comma.invalid).toEqual([])
    expect(comma.proxies.map((proxy) => proxy.url)).toEqual([
      "http://1.2.3.4:8080",
      "http://5.6.7.8:8080",
    ])
  })

  test("splits semicolon and space separated scheme'd addresses without credentials", () => {
    const semicolon = parseProxyList("socks5://1.2.3.4:1080; socks5://5.6.7.8:1080")

    expect(semicolon.invalid).toEqual([])
    expect(semicolon.proxies.map((proxy) => proxy.url)).toEqual([
      "socks5://1.2.3.4:1080",
      "socks5://5.6.7.8:1080",
    ])

    const space = parseProxyList("socks5://1.2.3.4:1080 socks5://5.6.7.8:1080")

    expect(space.invalid).toEqual([])
    expect(space.proxies.map((proxy) => proxy.url)).toEqual([
      "socks5://1.2.3.4:1080",
      "socks5://5.6.7.8:1080",
    ])
  })

  test("keeps passwords whole next to a credential-less address on the same line", () => {
    const parsed = parseProxyList("socks5://user:p;ss@host:1080, http://5.6.7.8:8080")

    expect(parsed.invalid).toEqual([])
    expect(parsed.proxies).toHaveLength(2)
    expect(parsed.proxies[0]?.username).toBe("user")
    expect(parsed.proxies[0]?.password).toBe("p;ss")
    expect(parsed.proxies[0]?.url).toBe("socks5://user:p%3Bss@host:1080")
    expect(parsed.proxies[1]?.url).toBe("http://5.6.7.8:8080")
  })

  test("keeps IPv6 addresses in brackets", () => {
    const proxy = parseProxyUrl("socks5://user:pass@[2001:db8::1]:1080")

    expect(proxy?.host).toBe("2001:db8::1")
    expect(proxy?.url).toBe("socks5://user:pass@[2001:db8::1]:1080")
    expect(proxy?.display).toBe("socks5://***@[2001:db8::1]:1080")
  })

  test("maps the scheme aliases", () => {
    expect(parseProxyUrl("socks://1.2.3.4:1080")?.scheme).toBe("socks5")
    expect(parseProxyUrl("socks5h://1.2.3.4:1080")?.scheme).toBe("socks5")
    expect(parseProxyUrl("socks4a://1.2.3.4:1080")?.scheme).toBe("socks4")
    expect(parseProxyUrl("https://1.2.3.4:443")?.scheme).toBe("https")
  })

  test("reads a JSON list from a provider", () => {
    const parsed = parseProxyList(
      JSON.stringify([
        { host: "1.2.3.4", port: 8001, protocol: "socks5", username: "u", password: "p" },
        { ip: "5.6.7.8", port: "8002" },
        "9.9.9.9:8003",
      ]),
    )

    expect(parsed.invalid).toEqual([])
    expect(parsed.proxies.map((proxy) => proxy.url)).toEqual([
      "socks5://u:p@1.2.3.4:8001",
      "http://5.6.7.8:8002",
      "http://9.9.9.9:8003",
    ])
  })

  test("reports each JSON entry it cannot convert, in order", () => {
    const parsed = parseProxyList(
      JSON.stringify([{ host: "1.2.3.4" }, { host: "5.6.7.8", port: 8080 }]),
    )

    expect(parsed.proxies.map((proxy) => proxy.url)).toEqual(["http://5.6.7.8:8080"])
    expect(parsed.invalid).toEqual([
      { value: '{"host":"1.2.3.4"}', reason: "the JSON entry has no port" },
    ])
  })

  test("an all-bad JSON list reports every entry instead of re-reading the text", () => {
    const parsed = parseProxyList(
      JSON.stringify([{ host: "1.2.3.4" }, { port: 8080 }]),
    )

    expect(parsed.proxies).toEqual([])
    expect(parsed.invalid).toEqual([
      { value: '{"host":"1.2.3.4"}', reason: "the JSON entry has no port" },
      { value: '{"port":8080}', reason: "the JSON entry has no host" },
    ])
  })

  test("a failed JSON entry with credentials reports them replaced", () => {
    const parsed = parseProxyList(
      JSON.stringify([{ host: "1.2.3.4", username: "alice", password: "s3cret" }]),
    )

    expect(parsed.proxies).toEqual([])
    expect(parsed.invalid).toHaveLength(1)
    expect(parsed.invalid[0]?.reason).toBe("the JSON entry has no port")
    expect(parsed.invalid[0]?.value).not.toContain("alice")
    expect(parsed.invalid[0]?.value).not.toContain("s3cret")
    expect(parsed.invalid[0]?.value).toContain('"username":"***"')
    expect(parsed.invalid[0]?.value).toContain('"password":"***"')
  })

  test("JSON that is neither a list nor an object is still read as text", () => {
    const parsed = parseProxyList(JSON.stringify("hello"))

    expect(parsed.proxies).toEqual([])
    expect(parsed.invalid[0]?.reason).toContain("host:port")
  })

  test("counts duplicates once, whatever their spelling", () => {
    const parsed = parseProxyList(`
      1.2.3.4:8080
      http://1.2.3.4:8080
      http://1.2.3.4:8080/
    `)

    expect(parsed.proxies).toHaveLength(1)
    expect(parsed.duplicates).toBe(2)
  })

  test("keeps credentials whose case differs as separate proxies", () => {
    // The password is case-sensitive: collapsing these would silently drop a
    // proxy that authenticates differently from the first.
    const parsed = parseProxyList(`
      user:PaSs@1.2.3.4:8080
      user:pass@1.2.3.4:8080
      USER:PaSs@1.2.3.4:8080
    `)

    expect(parsed.proxies).toHaveLength(3)
    expect(parsed.duplicates).toBe(0)
    expect(parsed.proxies.map((proxy) => proxy.url)).toEqual([
      "http://user:PaSs@1.2.3.4:8080",
      "http://user:pass@1.2.3.4:8080",
      "http://USER:PaSs@1.2.3.4:8080",
    ])

    // The address, on the other hand, is case-insensitive.
    const host = parseProxyList(`
      http://Proxy.Example:8080
      http://proxy.example:8080
    `)
    expect(host.proxies).toHaveLength(1)
    expect(host.duplicates).toBe(1)
  })

  test("drops comments and blank lines", () => {
    const parsed = parseProxyList(`
      # my list
      1.2.3.4:8080 # home
      // not a proxy

      5.6.7.8:8081
    `)

    expect(parsed.proxies.map((proxy) => proxy.port)).toEqual([8080, 8081])
    expect(parsed.invalid).toEqual([])
  })

  test("reports what it could not read, without the credentials", () => {
    const parsed = parseProxyList(`
      not-a-proxy
      1.2.3.4
      ftp://1.2.3.4:21
      secretuser:secretpass@1.2.3.4:99999
      ftp://alice:secret@1.2.3.4:21
      http://alice:secret@1.2.3.4:8080/path
      http://alice:secret@1.2.3.4:8080?x=1
      alice:secret@1.2.3.4
    `)

    expect(parsed.proxies).toEqual([])
    expect(parsed.invalid).toHaveLength(8)
    expect(parsed.invalid[0]?.reason).toContain("host:port")
    expect(parsed.invalid[1]?.reason).toContain("host:port")
    expect(parsed.invalid[2]?.reason).toContain("unknown proxy scheme")
    expect(parsed.invalid[3]?.reason).toContain("65535")
    expect(parsed.invalid[4]?.reason).toContain("unknown proxy scheme")
    expect(parsed.invalid[5]?.reason).toContain("path")
    expect(parsed.invalid[6]?.reason).toContain("query")
    expect(parsed.invalid[7]?.reason).toContain("host:port")
    for (const entry of parsed.invalid) {
      expect(entry.value).not.toContain("secret")
    }
    // The scheme, path, query and missing-port refusals used to echo the raw
    // token; each now reports the address with the credentials replaced.
    const credentialed = [parsed.invalid[4], parsed.invalid[5], parsed.invalid[6], parsed.invalid[7]]
    for (const entry of credentialed) {
      expect(entry?.value).not.toContain("alice:secret")
      expect(entry?.value).toContain("***@")
    }
    expect(parsed.invalid[4]?.value).toBe("***@1.2.3.4:21")
  })

  test("refuses a URL with a path or query", () => {
    expect(parseProxyUrl("http://1.2.3.4:8080/path")).toBeUndefined()
    expect(parseProxyUrl("http://1.2.3.4:8080?x=1")).toBeUndefined()
  })

  test("a list of nothing is nothing", () => {
    expect(parseProxyList("")).toEqual({ proxies: [], invalid: [], duplicates: 0 })
    expect(parseProxyList("   \n\n  ")).toEqual({ proxies: [], invalid: [], duplicates: 0 })
  })
})

describe("proxyKey", () => {
  test("lowercases the address but keeps the credentials verbatim", () => {
    expect(proxyKey("HTTP://User:PaSs@Proxy.Example:8080")).toBe(
      "http://User:PaSs@proxy.example:8080",
    )
    expect(proxyKey("socks5://u:p@[2001:DB8::1]:1080")).toBe(
      "socks5://u:p@[2001:db8::1]:1080",
    )
    // Without a scheme, the entry is already the identity it was given.
    expect(proxyKey("User:PaSs@Proxy.Example:8080")).toBe("User:PaSs@Proxy.Example:8080")
  })
})

describe("redactProxyToken", () => {
  test("removes the credentials but keeps the address", () => {
    expect(redactProxyToken("alice:secret@1.2.3.4:8080")).toBe("***@1.2.3.4:8080")
    expect(redactProxyToken("1.2.3.4:8080")).toBe("1.2.3.4:8080")
  })
})

describe("readBody", () => {
  test("reads the body from a copy and leaves the answer usable", async () => {
    const response = new Response("hello")

    const body = await readBody(response)

    expect(body).toBe("hello")
    expect(await response.text()).toBe("hello")
  })

  test("cuts a long body", async () => {
    const response = new Response("x".repeat(9000))

    expect(await readBody(response, 2000, 4000)).toHaveLength(4000)
  })

  test("cancels a body that takes too long instead of buffering it forever", async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("still going"))
      },
      cancel() {
        cancelled = true
      },
    })
    const response = { clone: () => ({ body: stream }) } as unknown as Response

    const body = await readBody(response, 25, 4000)

    expect(body).toBeUndefined()
    expect(cancelled).toBe(true)
  })
})
