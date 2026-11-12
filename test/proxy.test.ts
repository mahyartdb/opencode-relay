import { describe, expect, test } from "bun:test"
import { parseProxyList, parseProxyUrl, redactProxyToken } from "../src/lib/proxy.ts"

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

  test("reads host:port@user:pass in either order", () => {
    expect(parseProxyUrl("1.2.3.4:8080@bob:secret")?.url).toBe(
      "http://bob:secret@1.2.3.4:8080",
    )
    expect(parseProxyUrl("bob:secret@1.2.3.4:8080")?.url).toBe(
      "http://bob:secret@1.2.3.4:8080",
    )
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

  test("counts duplicates once, whatever their spelling", () => {
    const parsed = parseProxyList(`
      1.2.3.4:8080
      http://1.2.3.4:8080
      http://1.2.3.4:8080/
    `)

    expect(parsed.proxies).toHaveLength(1)
    expect(parsed.duplicates).toBe(2)
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

describe("redactProxyToken", () => {
  test("removes the credentials but keeps the address", () => {
    expect(redactProxyToken("alice:secret@1.2.3.4:8080")).toBe("***@1.2.3.4:8080")
    expect(redactProxyToken("1.2.3.4:8080")).toBe("1.2.3.4:8080")
  })
})
