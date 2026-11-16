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

/**
 * The identity of a proxy URL for deduplication.
 *
 * The scheme, host and port are case-insensitive, but the credentials are
 * not: `user:PaSs` and `user:pass` authenticate differently, so they are two
 * proxies and both must be kept. Only the address part is lowercased.
 */
export function proxyKey(url: string): string {
  const scheme = url.indexOf("://")
  if (scheme < 0) return url
  const rest = url.slice(scheme + 3)
  const at = rest.lastIndexOf("@")
  const auth = at >= 0 ? rest.slice(0, at + 1) : ""
  const address = at >= 0 ? rest.slice(at + 1) : rest
  const prefix = url.slice(0, scheme + 3).toLowerCase()
  return `${prefix}${auth}${address.toLowerCase()}`
}

/**
 * Remove credentials from an entry before it is shown in an error.
 *
 * The output is drawn in a dialog, so every control character is stripped:
 * the entry comes from a paste, and an escape sequence in it would be drawn
 * as one.
 */
export function redactProxyToken(value: string): string {
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\u001b]/g, "")
  const at = clean.lastIndexOf("@")
  if (at >= 0) {
    const after = clean.slice(at + 1)
    // Only the part after the @ may be shown when it really is an address:
    // the swapped host:port@user:pass shape would otherwise show the
    // password where the host belongs. When both sides read as host:port
    // the sides are ambiguous, so nothing after the @ is shown either. The
    // scheme is stripped before the check: it is never part of the address,
    // and it keeps the other side from parsing.
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(clean)
    const before = splitHostPort(
      (scheme === null ? clean : clean.slice(scheme[0].length)).slice(0, at),
    )
    const address = splitHostPort(after)
    const shown =
      address !== undefined &&
      address.port !== undefined &&
      !(before !== undefined && before.port !== undefined)
        ? after.slice(0, 100)
        : "***"
    return `***@${shown}`.slice(0, 120)
  }
  // The legacy host:port:user[:pass] shapes carry credentials after the
  // port with no @ to mark them. The port is what tells the two apart: a
  // number after the first colon is a port, so what follows it is a
  // credential. Anything else after the first colon is a credential itself,
  // so the password never reaches the screen.
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(clean)
  const prefix = scheme ? scheme[0] : ""
  const rest = scheme ? clean.slice(prefix.length) : clean
  const bracket = rest.startsWith("[") ? rest.indexOf("]") : -1
  const first = rest.indexOf(":", bracket >= 0 ? bracket : 0)
  if (first < 0) return clean.slice(0, 120)
  const second = rest.indexOf(":", first + 1)
  const port = second < 0 ? rest.slice(first + 1) : rest.slice(first + 1, second)
  if (!/^\d+$/.test(port)) return `${prefix}${rest.slice(0, first)}:***`.slice(0, 120)
  if (second < 0) return clean.slice(0, 120)
  return `${prefix}${rest.slice(0, second)}:***`.slice(0, 120)
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
  // Surrounding punctuation from a list, a CSV cell or a chat message. A dot
  // or a semicolon is not punctuation here: it may be the last character of a
  // password, and eating it would store a credential that was never typed.
  value = value.replace(/^[<("'`]+/, "").replace(/[>)"'`,]+$/, "")
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
  // noticing that the part after the @ is not a host:port at all — but when
  // BOTH sides read as host:port, the sides are ambiguous, and the address
  // is the side that looks like a machine: an IP literal, localhost, or a
  // dotted name. Taking the other side would store a password as a port and
  // show it in the menu.
  if (auth !== undefined && splitHostPort(auth) !== undefined && splitHostPort(hostPart) === undefined) {
    const swap = auth
    auth = hostPart
    hostPart = swap
  } else if (auth !== undefined && splitHostPort(auth) !== undefined && splitHostPort(hostPart) !== undefined) {
    const looksLikeAddress = (side: string): boolean => {
      const parsedSide = splitHostPort(side)
      if (parsedSide === undefined || parsedSide.port === undefined) return false
      const name = parsedSide.host.toLowerCase()
      return net.isIP(name) !== 0 || name === "localhost" || /\.[a-z]/i.test(name)
    }
    if (!looksLikeAddress(hostPart) && looksLikeAddress(auth)) {
      const swap = auth
      auth = hostPart
      hostPart = swap
    } else if (!looksLikeAddress(hostPart) && !looksLikeAddress(auth)) {
      // Neither side is a machine, so there is no way to tell the address
      // from the credentials: `intranet:3128@bob:44731` could be either.
      // Guessing would store a password as a port and show it in the menu,
      // so the entry is refused and the user is told how to write it.
      invalid(
        redactProxyToken(value),
        "that address is ambiguous: write it as scheme://user:pass@host:port",
      )
      return
    }
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
    // The masked form the details page shows is a display artifact, not a
    // credential. Accepting it would silently replace the real password with
    // three asterisks the next time a user edits an address that was shown
    // to them masked.
    if (username === "***" || password === "***") {
      invalid(redactProxyToken(original), "the credentials are masked; paste the full address with its credentials")
      return
    }
  }
  const proxy = buildProxy(scheme, host, port, username, password)
  if (!proxy) {
    invalid(redactProxyToken(original), "the entry could not be turned into a proxy URL")
    return
  }
  add(proxy)
}

/** Turn one JSON entry into a token, or say why it cannot be one. */
function jsonEntry(item: unknown): string | { readonly reason: string } {
  if (typeof item === "string") return item
  if (!item || typeof item !== "object") {
    return { reason: "the JSON entry is not a proxy object or an address string" }
  }
  const record = item as Record<string, unknown>
  const url = record["url"] ?? record["proxy"] ?? record["address"]
  if (typeof url === "string" && url.length > 0) return url
  const host = record["host"] ?? record["ip"] ?? record["server"] ?? record["hostname"]
  if (typeof host !== "string" || host.length === 0) return { reason: "the JSON entry has no host" }
  const port = record["port"] ?? record["proxy_port"] ?? record["portNumber"]
  const portText = typeof port === "number" ? String(port) : typeof port === "string" ? port : ""
  if (portText.length === 0) return { reason: "the JSON entry has no port" }
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

/**
 * Show a failed JSON entry with its credentials removed.
 *
 * The address may sit under any key, at any depth, and a credential may be
 * a number or a list as easily as a string, so every value under a
 * credential-named key is masked outright, and every string anywhere goes
 * through the same masking as a pasted line: an entry whose password lives
 * under "proxies[0].url" must not show it either.
 */
function redactJsonEntry(item: unknown): string {
  const walk = (value: unknown, key: string | undefined): unknown => {
    // A field whose name says it holds a credential is masked whole,
    // whatever its type: a numeric password or a list of tokens is one too.
    if (
      key !== undefined &&
      /pass|pwd|secret|token|key|user|auth|credential|login|session|cookie/i.test(key)
    ) {
      return "***"
    }
    if (Array.isArray(value)) return value.map((inner) => walk(inner, undefined))
    if (value !== null && typeof value === "object") {
      const record: Record<string, unknown> = {}
      for (const [name, inner] of Object.entries(value as Record<string, unknown>)) {
        record[name] = walk(inner, name)
      }
      return record
    }
    return typeof value === "string" ? redactProxyToken(value) : value
  }
  return JSON.stringify(walk(item, undefined))
}

/** An entry refused before it could become a token, with its reason. */
interface RefusedToken {
  readonly value: string
  readonly reason: string
}

/**
 * Whether an `@` still closes credentials ahead of a separator position.
 *
 * It must do so before the next separator and before the `://` that would
 * start the next scheme'd address: otherwise the `@` belongs to a later
 * token, and the separator here ends this one. A scheme'd address without
 * credentials has no `@` at all, so its separators split the line.
 */
function credentialsAhead(line: string, from: number): boolean {
  const rest = line.slice(from + 1)
  const at = rest.indexOf("@")
  if (at < 0) return false
  const separator = rest.search(/[\s,;]/)
  if (separator >= 0 && at > separator) return false
  const scheme = rest.indexOf("://")
  return scheme < 0 || at < scheme
}

/**
 * Split a line at whitespace, commas and semicolons, but not inside
 * credentials.
 *
 * A separator after `scheme://` but before the `@` that closes the
 * credentials belongs to the password, so it stays in the token — but only
 * when an `@` really does close credentials ahead of the separator; once the
 * `@` has been seen, separators split the line again. A bare `host:port`
 * token splits as before.
 */
function splitLine(line: string): string[] {
  const parts: string[] = []
  let current = ""
  let scheme = false
  let credentials = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? ""
    if (char === ":" && !scheme && line.slice(index, index + 3) === "://") {
      scheme = true
    } else if (char === "@" && scheme) {
      credentials = true
    }
    if (/[\s,;]/.test(char) && !(scheme && !credentials && credentialsAhead(line, index))) {
      if (current.length > 0) parts.push(current)
      current = ""
      scheme = false
      credentials = false
      continue
    }
    current += char
  }
  if (current.length > 0) parts.push(current)
  return parts
}

/**
 * Tokens from a paste: JSON, lines, commas, semicolons and plain spaces.
 *
 * Once the text parses as JSON, every entry is accounted for — the ones that
 * convert come back as tokens, the others as refusals with a reason — and the
 * text is never read as a list again.
 */
function tokens(text: string): (string | RefusedToken)[] {
  const trimmed = text.trim()
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (Array.isArray(parsed) || (parsed !== null && typeof parsed === "object")) {
        const items = Array.isArray(parsed) ? parsed : [parsed]
        const entries: (string | RefusedToken)[] = []
        for (const item of items) {
          const entry = jsonEntry(item)
          if (typeof entry === "string") entries.push(entry)
          else entries.push({ value: redactJsonEntry(item), reason: entry.reason })
        }
        return entries
      }
      // Not a list or an object, so it is read as a list of lines.
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
    tokens.push(...splitLine(withoutComment))
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
    const key = proxyKey(proxy.url)
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

  for (const entry of tokens(text)) {
    if (typeof entry === "string") readToken(entry, add, refuse)
    else refuse(entry.value, entry.reason)
  }
  return { proxies, invalid, duplicates }
}

/** One proxy URL as it may be typed by hand. */
export function parseProxyUrl(value: string): ParsedProxy | undefined {
  const parsed = parseProxyList(value)
  return parsed.proxies[0]
}
