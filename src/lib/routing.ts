/**
 * Which models go through a relay, and the little protocol the relay speaks.
 *
 * The relay itself is a dumb forwarder: it only knows the upstream origin, the path
 * to call and the access token, and it answers with headers that say whether the
 * client should try another instance. Every decision about *whether* to route, and
 * every decision about *how* to talk to the relay, lives here.
 */

import { UPSTREAM_HOST, type ModelInfo, type Selection } from "./types.ts"

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

/** Relay headers we own, so a stale value from the caller never reaches the relay. */
const RELAY_HEADERS = new Set([
  "x-relay-target",
  "x-relay-path",
  "x-relay-key",
  "x-relay-avoid",
  "x-relay-control",
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
 * renames the display name of a model.
 */
export function isSelected(
  model: RoutableModel,
  selection: Selection,
  customModels: readonly string[],
): boolean {
  if (selection === "all") return true
  if (selection === "free") return isFree(model)
  return customModels.includes(model.id)
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

/** Where a request goes, and which addresses the client already knows to be used up. */
export interface RelayTarget {
  readonly url: string
  readonly access: string
  readonly avoid?: readonly string[]
}

/** The only origin a relay is allowed to forward to. */
const UPSTREAM_ORIGIN = `https://${UPSTREAM_HOST}`

/** Bun has to be told the body is streamed, so it may send it while it is still read. */
type StreamedRequestInit = RequestInit & { duplex?: "half" }

/** A relay url as people write it: without a scheme, or with a trailing slash. */
function normalizeRelayUrl(url: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`
  return withScheme.endsWith("/") ? withScheme.slice(0, -1) : withScheme
}

/**
 * Turn a provider request into one the relay serves.
 *
 * The relay answers on the root of its own url and reads the real call from the
 * x-relay-* headers, so the request line carries the relay and the headers carry
 * the intent. The body is never read here: it is handed over as the stream it
 * already is, so a long inference is forwarded while it is still being produced.
 */
export function relayRequest(request: Request, target: RelayTarget): Request {
  const source = new URL(request.url, UPSTREAM_ORIGIN)
  const path = `${source.pathname}${source.search}`

  const headers = new Headers()
  request.headers.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower)) return
    if (RELAY_HEADERS.has(lower)) return
    headers.set(name, value)
  })

  headers.set("x-relay-target", UPSTREAM_ORIGIN)
  headers.set("x-relay-path", path.startsWith("/") ? path : `/${path}`)
  headers.set("x-relay-key", target.access)
  if (target.avoid && target.avoid.length > 0) {
    headers.set("x-relay-avoid", target.avoid.join(","))
  }

  const method = request.method
  const body = request.body
  const init: StreamedRequestInit = {
    method,
    headers,
    signal: request.signal,
  }
  if (body !== null && method !== "GET" && method !== "HEAD") {
    init.body = body
    init.duplex = "half"
  }

  return new Request(normalizeRelayUrl(target.url), init)
}

/** What a relay answer says about the instance that served it. */
export interface ResponseState {
  /** True when the instance is used up and the client should try another one. */
  readonly rotate: boolean
  /** True when the free allowance of this address is exhausted. */
  readonly spent: boolean
  /** The address the answer came from, when the relay reported one. */
  readonly egress?: string
}

/**
 * Read the relay's verdict from the status and the headers alone.
 *
 * The body belongs to the caller, streaming, and reading it here would eat the
 * answer before it reaches OpenCode.
 */
export function readResponseState(response: Response): ResponseState {
  const rotate = response.status === 409 && response.headers.get("x-relay-rotate") === "1"
  const spent = response.status === 429
  const egress = response.headers.get("x-relay-egress") ?? undefined
  return {
    rotate,
    spent,
    ...(egress !== undefined ? { egress } : {}),
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
