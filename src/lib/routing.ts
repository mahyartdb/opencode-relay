/**
 * Which models go through an exit, and the little protocol an exit speaks.
 *
 * A relay is a dumb forwarder: it only knows the upstream origin, the path to
 * call and the access token, and it answers with headers that say whether the
 * client should try another instance. A proxy is even dumber: it only carries
 * bytes. Every decision about *whether* to route, and every decision about
 * *how* to talk to the exit, lives here.
 */

import {
  UPSTREAM_HOST,
  type ExitKind,
  type ExitStatus,
  type ModelInfo,
  type Selection,
  type Strategy,
} from "./types.ts"

/** One pricing tier of a model, in dollars per million tokens. */
export interface ModelCost {
  readonly input: number
  readonly output: number
}

/** The part of a model the routing rules need to look at. */
export interface RoutableModel {
  readonly id: string
  readonly name: string
  /** Pricing tiers, when the provider published them. */
  readonly cost?: readonly ModelCost[]
}

/** Headers that describe a single hop and must never be forwarded. */
const HOP_BY_HOP = new Set([
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
])

/**
 * The marker this plugin puts on a relay request.
 *
 * It is how an answer is traced back to the relay that served it: with more
 * than one exit in use, the exit that answered is not always the one the user
 * chose. The relay drops every x-relay-* header before forwarding, so the
 * marker never reaches the provider.
 */
export const RELAY_ID_HEADER = "x-relay-id"

/** The marker a request sent through the local proxy bridge carries. */
export const BRIDGE_EXIT_HEADER = "x-bridge-exit"
export const BRIDGE_TARGET_HEADER = "x-bridge-target"
export const BRIDGE_KEY_HEADER = "x-bridge-key"

/** Exit headers we own, so a stale value from the caller never reaches the exit. */
const RELAY_HEADERS = new Set([
  "x-relay-target",
  "x-relay-path",
  "x-relay-key",
  "x-relay-avoid",
  "x-relay-control",
  RELAY_ID_HEADER,
  BRIDGE_EXIT_HEADER,
  BRIDGE_TARGET_HEADER,
  BRIDGE_KEY_HEADER,
])

/**
 * A model is free when every one of its pricing tiers costs nothing.
 *
 * A model without pricing is not free: an unknown price is not a zero price, and
 * guessing wrong there would spend the free allowance on a paid model.
 */
export function isFree(model: RoutableModel): boolean {
  if (!model.cost) return false
  return model.cost.every((tier) => tier.input === 0 && tier.output === 0)
}

/**
 * Whether a model is routed under the current selection.
 *
 * The custom list is matched by model id, so it keeps working when the provider
 * renames the display name of a model. Only free models are ever routed: the
 * plugin exists to multiply the free allowance, and a paid model would spend
 * money through an exit that cannot make it cheaper.
 */
export function isSelected(
  model: RoutableModel,
  selection: Selection,
  customModels: readonly string[],
): boolean {
  if (!isFree(model)) return false
  if (selection === "free") return true
  return customModels.includes(model.id)
}

/** The least a routing candidate has to say about itself. */
export interface ExitCandidate {
  readonly id: string
  readonly kind: ExitKind
  readonly name: string
  readonly status: ExitStatus
  readonly latencyMs?: number
}

/** Why an exit is not in the usable list. */
export interface ExitSkip {
  readonly exit: ExitCandidate
  readonly reason: string
}

/**
 * Which exit serves the next request.
 *
 * The caller passes the exits that can serve *right now* (enabled, tested,
 * answering, not cooling, not used up), so this function only applies the
 * strategy. Keeping the filter outside makes the rule that decides usability
 * testable on its own, and keeps the strategy honest: it can never pick an
 * exit the state rejected.
 *
 * `cursor` only moves for round robin. The one-exit and until-exhausted
 * strategies prefer the chosen exit and fall back to the first usable one; the
 * state persists a new choice for until-exhausted when the old one runs out.
 */
export function nextExit<T extends ExitCandidate>(
  usable: readonly T[],
  all: readonly T[],
  options: {
    readonly strategy: Strategy
    /** The exit the user chose, for the strategies that prefer one. */
    readonly activeId?: string
    /** Where the last request went, for the strategy that moves on each time. */
    readonly cursor: number
  },
): { readonly exit: T | undefined; readonly cursor: number } {
  if (usable.length === 0) return { exit: undefined, cursor: options.cursor }

  switch (options.strategy) {
    case "fixed": {
      // Prefer the exit the user chose. When it cannot serve, another one takes
      // over: the alternative is spending the local allowance silently, which
      // is the behavior this plugin exists to avoid.
      const chosen = usable.find((exit) => exit.id === options.activeId)
      return { exit: chosen ?? usable[0], cursor: options.cursor }
    }
    case "round-robin": {
      // The cursor moves on every request, so the requests are spread out.
      const index = ((options.cursor % usable.length) + usable.length) % usable.length
      return { exit: usable[index], cursor: options.cursor + 1 }
    }
    case "exhausted": {
      // The chosen exit is used until it is used up. When it is, the next
      // usable one in the overall order takes over, so adding or pausing an
      // exit does not send traffic to something the state already rejected.
      const chosen = usable.find((exit) => exit.id === options.activeId)
      if (chosen) return { exit: chosen, cursor: options.cursor }
      const index = all.findIndex((exit) => exit.id === options.activeId)
      for (let step = 1; index >= 0 && step <= all.length; step++) {
        const candidate = all[(index + step) % all.length]
        if (candidate && usable.some((exit) => exit.id === candidate.id)) {
          return { exit: candidate, cursor: options.cursor }
        }
      }
      return { exit: usable[0], cursor: options.cursor }
    }
    case "fastest": {
      // A relay with no measured latency is not assumed fast: it comes after
      // every exit that has answered at least once. Ties keep list order.
      let best = usable[0]
      let bestMs = best?.latencyMs ?? Number.POSITIVE_INFINITY
      for (const exit of usable.slice(1)) {
        const ms = exit.latencyMs ?? Number.POSITIVE_INFINITY
        if (ms < bestMs) {
          best = exit
          bestMs = ms
        }
      }
      return { exit: best, cursor: options.cursor }
    }
  }
}

/** Describe the models for the UI: what they cost and whether they are routed. */
export function selectModels(
  models: readonly RoutableModel[],
  selection: Selection,
  customModels: readonly string[],
): readonly ModelInfo[] {
  return models.map((model) => ({
    id: model.id,
    name: model.name,
    free: isFree(model),
    routed: isSelected(model, selection, customModels),
  }))
}

/** Where a relay request goes, and which addresses the client already knows to be used up. */
export interface RelayTarget {
  readonly url: string
  readonly access: string
  /** This plugin's id for the relay, so an answer can be traced back to it. */
  readonly id?: string
  readonly avoid?: readonly string[]
}

/** Where a proxied request goes: the local bridge, and which proxy it must use. */
export interface ProxyTarget {
  /** The local bridge's origin, e.g. http://127.0.0.1:43121 */
  readonly bridge: string
  /** The bridge's per-process secret. */
  readonly key: string
  /** This plugin's id for the proxy. */
  readonly id: string
}

/** The only origin a relay is allowed to forward to. */
const UPSTREAM_ORIGIN = `https://${UPSTREAM_HOST}`

/** Bun has to be told the body is streamed, so it may send it while it is still read. */
type StreamedRequestInit = RequestInit & { duplex?: "half" }

/** A relay url as people write it: without a scheme, or with a trailing slash. */
export function normalizeRelayUrl(url: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`
  return withScheme.endsWith("/") ? withScheme.slice(0, -1) : withScheme
}

/** Copy the headers of a request, dropping the hop-by-hop and exit-owned ones. */
function forwardedHeaders(request: Request): Headers {
  const headers = new Headers()
  request.headers.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower)) return
    if (RELAY_HEADERS.has(lower)) return
    headers.set(name, value)
  })
  return headers
}

/**
 * Turn a provider request into one the relay serves.
 *
 * The relay answers on the root of its own url and reads the real call from the
 * x-relay-* headers, so the request line carries the relay and the headers carry
 * the intent. The body is handed over as the stream it already is, which keeps
 * the *shape* of a streamed body, but on OpenCode 2.2.7 the host rebuilds a
 * replaced request with `HttpClientRequest.fromWeb` and re-buffers
 * `clone().arrayBuffer()`, so the body is read in full before anything is
 * sent. `redirect: "manual"` and the signal are best-effort for the same
 * reason: the host drops both when it rebuilds. The relay never follows an
 * upstream redirect itself, so a platform redirect still cannot carry the
 * access token to a host the user did not choose.
 */
export function relayRequest(request: Request, target: RelayTarget): Request {
  const source = new URL(request.url, UPSTREAM_ORIGIN)
  const path = `${source.pathname}${source.search}`
  const headers = forwardedHeaders(request)

  headers.set("x-relay-target", UPSTREAM_ORIGIN)
  headers.set("x-relay-path", path.startsWith("/") ? path : `/${path}`)
  headers.set("x-relay-key", target.access)
  if (target.id !== undefined) headers.set(RELAY_ID_HEADER, target.id)
  if (target.avoid && target.avoid.length > 0) {
    headers.set("x-relay-avoid", target.avoid.join(","))
  }

  const method = request.method
  const body = request.body
  const init: StreamedRequestInit = {
    method,
    headers,
    signal: request.signal,
    redirect: "manual",
  }
  if (body !== null && method !== "GET" && method !== "HEAD") {
    init.body = body
    init.duplex = "half"
  }

  return new Request(normalizeRelayUrl(target.url), init)
}

/**
 * Turn a provider request into one the local bridge serves.
 *
 * The bridge is the process that calls `fetch` with Bun's `proxy` option, so
 * the hook only has to point the request at loopback and say which proxy to
 * use. The target URL travels in a header. The body is handed over as the
 * stream it already is, which keeps the *shape* of a streamed body, but on
 * OpenCode 2.2.7 the host rebuilds a replaced request with
 * `HttpClientRequest.fromWeb` and re-buffers `clone().arrayBuffer()`, so it is
 * read in full before the bridge is even called. `redirect: "manual"` and the
 * signal are best-effort for the same reason: the host drops both when it
 * rebuilds, and the bridge never follows a redirect of its own.
 */
export function proxyRequest(request: Request, target: ProxyTarget): Request {
  const headers = forwardedHeaders(request)
  headers.set(BRIDGE_KEY_HEADER, target.key)
  headers.set(BRIDGE_EXIT_HEADER, target.id)
  headers.set(BRIDGE_TARGET_HEADER, request.url)

  const method = request.method
  const body = request.body
  const init: StreamedRequestInit = {
    method,
    headers,
    signal: request.signal,
    redirect: "manual",
  }
  if (body !== null && method !== "GET" && method !== "HEAD") {
    init.body = body
    init.duplex = "half"
  }
  return new Request(target.bridge, init)
}

/** The relay a request was sent through, when this plugin marked it. */
export function relayIdOf(request: Request): string | undefined {
  return request.headers.get(RELAY_ID_HEADER) ?? undefined
}

/** The proxy a request was sent through, when this plugin marked it. */
export function proxyIdOf(request: Request): string | undefined {
  return request.headers.get(BRIDGE_EXIT_HEADER) ?? undefined
}

/** The exit a request was sent through, whichever kind it was. */
export function exitIdOf(request: Request): string | undefined {
  return relayIdOf(request) ?? proxyIdOf(request)
}

/** What a relay answer says about the instance that served it. */
export interface ResponseState {
  /** True when the instance is used up and the client should try another one. */
  readonly rotate: boolean
  /** The address the answer came from, when the relay reported one. */
  readonly egress?: string
  /** The relay instance that answered, when it said. */
  readonly instance?: string
  /** The runtime behind the relay, when it said. */
  readonly runtime?: string
  /** True when the answer came from the upstream through an exit, not from the edge. */
  readonly reachedExit: boolean
}

/**
 * Read the relay's verdict from the status and the headers alone.
 *
 * The body belongs to the caller, streaming, and reading it here would eat the
 * answer before it reaches OpenCode. A 429 is deliberately *not* labelled
 * spent here: only the body and a confirmation request can tell a used-up
 * allowance from a rate limit on one request.
 */
export function readResponseState(response: Response): ResponseState {
  const rotate = response.status === 409 && response.headers.get("x-relay-rotate") === "1"
  const egress = response.headers.get("x-relay-egress") ?? undefined
  const instance = response.headers.get("x-relay-instance") ?? undefined
  const runtime = response.headers.get("x-relay-runtime") ?? undefined
  const reachedExit = instance !== undefined || runtime !== undefined || egress !== undefined
  return {
    rotate,
    reachedExit,
    ...(egress !== undefined ? { egress } : {}),
    ...(instance !== undefined ? { instance } : {}),
    ...(runtime !== undefined ? { runtime } : {}),
  }
}

/**
 * Whether an error body says the free allowance is used up.
 *
 * The provider words this error in more than one way, so the text is flattened
 * before it is looked at: punctuation and casing have never told us anything.
 */
export function isFreeUsageLimit(body: string): boolean {
  const flat = body.toLowerCase().replace(/[^a-z0-9]/g, "")
  if (flat.includes("freeusagelimit")) return true
  return flat.includes("free") && flat.includes("usagelimit")
}

/**
 * A Retry-After header in milliseconds.
 *
 * It is either a number of seconds or an HTTP date. A missing or unreadable
 * value is zero, which means "the provider did not say", not "retry now".
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number {
  if (!value) return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000))
  const at = Date.parse(value)
  if (!Number.isFinite(at)) return 0
  return Math.max(0, at - now)
}

/** The text of an answer's body, read from a copy so the caller still gets it. */
export async function readBody(
  response: Response,
  timeoutMs = 2000,
  limit = 4000,
): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const copy = response.clone()
    const text = await Promise.race([
      copy.text(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs)
      }),
    ])
    return text === undefined ? undefined : text.slice(0, limit)
  } catch {
    return undefined
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
