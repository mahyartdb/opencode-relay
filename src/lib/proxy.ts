/**
 * Reading a pasted list of proxies.
 *
 * People get proxy lists in every shape there is: one per line, several per
 * line, `host:port`, `host:port:user:pass`, `scheme://user:pass@host:port`,
 * JSON exported from a provider. The parser accepts all of them and says what
 * it could not read instead of silently dropping it.
 *
 * Nothing here performs a request or trusts a proxy. It only turns text into
 * normalized URLs, so an invalid line cannot become a routing entry that fails
 * later in a harder-to-explain way.
 */
import net from "node:net"

/** The proxy protocols OpenCode traffic can use through the local bridge. */
export type ProxyScheme = "http" | "https" | "socks4" | "socks5"

/** One proxy read from a list. */
export interface ParsedProxy {
  readonly scheme: ProxyScheme
  /** The normalized URL, with credentials kept. This is what is stored. */
  readonly url: string
  /** The address to show, without credentials. */
  readonly display: string
  readonly host: string
  readonly port: number
  readonly username?: string
  readonly password?: string
}

/** A line the parser refused, with a reason the user can act on. */
export interface InvalidProxy {
  /** The entry as pasted, with any credentials removed. */
  readonly value: string
  readonly reason: string
}

export interface ParsedProxyList {
  readonly proxies: readonly ParsedProxy[]
  readonly invalid: readonly InvalidProxy[]
  /** Entries that were valid but repeated another entry in the same paste. */
  readonly duplicates: number
}

const SCHEMES: Record<string, ProxyScheme> = {
  http: "http",
  https: "https",
  socks: "socks5",
  socks4: "socks4",
  socks4a: "socks4",
  socks5: "socks5",
  socks5h: "socks5",
}

/** A hostname that is not an IP: labels of letters, digits and hyphens. */
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i

/** Remove credentials from an entry before it is shown in an error. */
export function redactProxyToken(value: string): string {
  const at = value.lastIndexOf("@")
  if (at < 0) return value.slice(0, 120)
  return `***@${value.slice(at + 1).slice(0, 100)}`
}

/** Decode a credential when it is percent-encoded; keep it otherwise. */
function decodeCredential(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Build the stored URL and the display URL from the parts. */
function buildProxy(
  scheme: ProxyScheme,
  host: string,
  port: number,
  username?: string,
  password?: string,
): ParsedProxy | undefined {
  const hostPart = net.isIPv6(host) ? `[${host}]` : host
  const user = username?.length ? encodeURIComponent(decodeCredential(username)) : ""
  const pass = password !== undefined && password.length > 0 ? encodeURIComponent(decodeCredential(password)) : ""
  const auth = user.length > 0 ? `${user}${pass.length > 0 ? `:${pass}` : ""}@` : ""
  const url = `${scheme}://${auth}${hostPart}:${port}`
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== `${scheme}:`) return undefined
    if (parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase() !== host.toLowerCase()) return undefined
    // URL hides a scheme's default port: https://host:443 reads back port "".
    // A proxy on the default port is still a valid proxy, so put it back.
    const effective =
      parsed.port.length > 0
        ? Number(parsed.port)
        : scheme === "https"
          ? 443
          : scheme === "http"
            ? 80
            : Number.NaN
    if (effective !== port) return undefined
  } catch {
    return undefined
  }
  return {
    scheme,
    url,
    display: `${scheme}://${user.length > 0 ? "***@" : ""}${hostPart}:${port}`,
    host,
    port,
    ...(username?.length ? { username } : {}),
    ...(password !== undefined && password.length > 0 ? { password } : {}),
  }
}

/** Split a host and port, including the bracketed IPv6 form. */
function splitHostPort(value: string): { host: string; port?: number } | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(trimmed)
  if (bracketed) {
    const host = bracketed[1] ?? ""
    if (!net.isIPv6(host)) return undefined
    const port = bracketed[2] === undefined ? undefined : Number(bracketed[2])
    return port === undefined ? { host } : { host, port }
  }
  // A bare IPv6 address has colons but no port; it cannot be a proxy without a
  // port, so it is not accepted here.
  const single = /^([^:\s/]+)(?::(\d{1,5}))?$/.exec(trimmed)
  if (!single) return undefined
  const host = single[1] ?? ""
  const port = single[2] === undefined ? undefined : Number(single[2])
  return port === undefined ? { host } : { host, port }
}

/** Whether the host is something a proxy URL can point at. */
function validHost(host: string): boolean {
  const value = host.toLowerCase()
  if (value.length === 0) return false
  if (net.isIP(value) !== 0) return true
  return HOSTNAME.test(value)
}

/** Add one token, or say why it was refused. */
function readToken(
  token: string,
  add: (proxy: ParsedProxy) => void,
  invalid: (value: string, reason: string) => void,
): void {
  let value = token.trim()
  // Surrounding punctuation from a list, a CSV cell or a chat message.
  value = value.replace(/^[<("'`]+/, "").replace(/[>)"'`,.;]+$/, "")
  if (value.length === 0) return
  if (value.startsWith("//")) return

  let schemeName: ProxyScheme = "http"
  const withScheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value)
  if (withScheme) {
    const name = withScheme[1]?.toLowerCase() ?? ""
    const mapped = SCHEMES[name]
    if (!mapped) {
      invalid(redactProxyToken(value), `unknown proxy scheme "${name}"`)
      return
    }
    schemeName = mapped
    value = value.slice(withScheme[0].length)
    const slash = value.indexOf("/")
    if (slash >= 0) {
      const rest = value.slice(slash)
      if (rest !== "/") {
        invalid(redactProxyToken(value), "a proxy address cannot have a path")
        return
      }
      value = value.slice(0, slash)
    }
    const question = value.indexOf("?")
    if (question >= 0) {
      invalid(redactProxyToken(value), "a proxy address cannot have a query")
      return
    }
    const hash = value.indexOf("#")
    if (hash >= 0) value = value.slice(0, hash)
  }

  let auth: string | undefined
  let hostPart = value
  const at = value.lastIndexOf("@")
  if (at >= 0) {
    auth = value.slice(0, at)
    hostPart = value.slice(at + 1)
  }

  // Some lists write host:port:user:pass. The host may be a bracketed IPv6.
  const legacy = /^(\[[^\]]+\]|[^:/\s]+):(\d{1,5}):([^:]+):(.*)$/.exec(hostPart)
  if (legacy) {
    const host = legacy[1] ?? ""
    const port = Number(legacy[2])
    const username = legacy[3] ?? ""
    const password = legacy[4] ?? ""
    finish(schemeName, host, port, auth ?? `${username}:${password}`, add, invalid, token)
    return
  }
  // host:port:user (a username with no password) is also common.
  const legacyUser = /^(\[[^\]]+\]|[^:/\s]+):(\d{1,5}):([^:/\s]+)$/.exec(hostPart)
  if (legacyUser) {
    finish(
      schemeName,
      legacyUser[1] ?? "",
      Number(legacyUser[2]),
      auth ?? `${legacyUser[3] ?? ""}:`,
      add,
      invalid,
      token,
    )
    return
  }

  // host:port@user:pass puts the credentials after the address. Detect it by
  // noticing that the part after the @ is not a host:port at all.
  if (auth !== undefined && splitHostPort(auth) !== undefined && splitHostPort(hostPart) === undefined) {
    const swap = auth
    auth = hostPart
    hostPart = swap
  }

  const parsed = splitHostPort(hostPart)
  if (!parsed || parsed.port === undefined) {
    invalid(redactProxyToken(value), "expected host:port")
    return
  }
  finish(schemeName, parsed.host, parsed.port, auth, add, invalid, token)
}

/** Validate the parts, then hand a normalized proxy to the collector. */
function finish(
  scheme: ProxyScheme,
  rawHost: string,
  port: number,
  auth: string | undefined,
  add: (proxy: ParsedProxy) => void,
  invalid: (value: string, reason: string) => void,
  original: string,
): void {
  const host = rawHost.replace(/^\[|\]$/g, "").trim()
  if (!validHost(host)) {
    invalid(redactProxyToken(original), `"${host}" is not a host name or an IP address`)
    return
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    invalid(redactProxyToken(original), "the port must be between 1 and 65535")
    return
  }
  let username: string | undefined
  let password: string | undefined
  if (auth !== undefined && auth.length > 0) {
    const colon = auth.indexOf(":")
    if (colon < 0) {
      if (auth.includes("@")) {
        invalid(redactProxyToken(original), "the credentials contain an unescaped @")
        return
      }
      username = auth
    } else {
      username = auth.slice(0, colon)
      password = auth.slice(colon + 1)
    }
  }
  const proxy = buildProxy(scheme, host, port, username, password)
  if (!proxy) {
    invalid(redactProxyToken(original), "the entry could not be turned into a proxy URL")
    return
  }
  add(proxy)
}

/** Turn one JSON entry into a token the text parser understands. */
function jsonEntry(item: unknown): string | undefined {
  if (typeof item === "string") return item
  if (!item || typeof item !== "object") return undefined
  const record = item as Record<string, unknown>
  const url = record["url"] ?? record["proxy"] ?? record["address"]
  if (typeof url === "string" && url.length > 0) return url
  const host = record["host"] ?? record["ip"] ?? record["server"] ?? record["hostname"]
  if (typeof host !== "string" || host.length === 0) return undefined
  const port = record["port"] ?? record["proxy_port"] ?? record["portNumber"]
  const portText = typeof port === "number" ? String(port) : typeof port === "string" ? port : ""
  if (portText.length === 0) return undefined
  const protocol = record["protocol"] ?? record["type"] ?? record["scheme"] ?? record["protocols"]
  const scheme = typeof protocol === "string" ? protocol.split(",")[0]?.trim().toLowerCase() : ""
  const prefix = scheme && SCHEMES[scheme] ? `${SCHEMES[scheme]}://` : ""
  const username = record["username"] ?? record["user"]
  const password = record["password"] ?? record["pass"]
  const auth =
    typeof username === "string" && username.length > 0
      ? `${encodeURIComponent(username)}${typeof password === "string" ? `:${encodeURIComponent(password)}` : ""}@`
      : ""
  return `${prefix}${auth}${host}:${portText}`
}

/** Tokens from a paste: JSON, lines, commas, semicolons and plain spaces. */
function tokens(text: string): string[] {
  const trimmed = text.trim()
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      const items = Array.isArray(parsed) ? parsed : [parsed]
      const converted = items
        .map((item) => jsonEntry(item))
        .filter((item): item is string => item !== undefined)
      if (converted.length > 0) return converted
    } catch {
      // Not JSON, so it is read as a list.
    }
  }
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  const tokens: string[] = []
  for (const line of lines) {
    // A comment starts at the beginning of a line or after whitespace. A `#`
    // inside a URL stays part of the URL and is stripped later.
    const withoutComment = line.replace(/(^|\s)#.*$/, "$1").trim()
    if (withoutComment.length === 0 || withoutComment.startsWith("//")) continue
    tokens.push(...withoutComment.split(/[\s,;]+/).filter(Boolean))
  }
  return tokens
}

/**
 * Read a pasted proxy list.
 *
 * The same proxy written twice is counted once. A line that cannot be read is
 * reported with its reason and with its credentials removed, so a typo in a
 * long list is fixable without guessing which line it was.
 */
export function parseProxyList(text: string): ParsedProxyList {
  const seen = new Set<string>()
  const proxies: ParsedProxy[] = []
  const invalid: InvalidProxy[] = []
  let duplicates = 0

  const add = (proxy: ParsedProxy) => {
    const key = proxy.url.toLowerCase()
    if (seen.has(key)) {
      duplicates++
      return
    }
    seen.add(key)
    proxies.push(proxy)
  }
  const refuse = (value: string, reason: string) => {
    invalid.push({ value: value.slice(0, 120), reason })
  }

  for (const token of tokens(text)) readToken(token, add, refuse)
  return { proxies, invalid, duplicates }
}

/** One proxy URL as it may be typed by hand. */
export function parseProxyUrl(value: string): ParsedProxy | undefined {
  const parsed = parseProxyList(value)
  return parsed.proxies[0]
}
