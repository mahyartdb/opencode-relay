/**
 * Shared shapes for the relay plugin.
 *
 * The server part owns the truth (accounts, exits, routing rules). The TUI
 * part only ever reads and writes through the RPC contract in `rpc.ts`, so
 * both sides agree on these types without importing each other.
 *
 * An exit is anything that can carry an OpenCode request from a different
 * address: a relay deployed to Vercel, or an HTTP/SOCKS proxy the user added.
 * The routing rules treat both the same way, because the thing OpenCode meters
 * is the address the request leaves from, not the machinery in between.
 */

export const PROVIDER_ID = "opencode"

/** The upstream the relay forwards to. */
export const UPSTREAM_HOST = "opencode.ai"

/** Default path prefix OpenCode Free serves inference under. */
export const UPSTREAM_BASE = "https://opencode.ai/inference/openai/v1"

/** The model list OpenCode Free answers without a session token. */
export const UPSTREAM_MODELS = "https://opencode.ai/inference/v1/models"

/** The chat endpoint a real test uses when no request shaped one is known. */
export const UPSTREAM_CHAT = "https://opencode.ai/inference/openai/v1/chat/completions"

/** Where an exit says which address it is seen from. */
export const UPSTREAM_TRACE = "https://opencode.ai/cdn-cgi/trace"

/** Where a relay is deployed. Each region is its own Vercel project. */
export interface Region {
  /** Vercel region code, e.g. `fra1`. */
  readonly code: string
  /** Human label, e.g. `Frankfurt`. */
  readonly label: string
}

export const REGIONS: readonly Region[] = [
  { code: "fra1", label: "Frankfurt" },
  { code: "iad1", label: "Washington, D.C." },
  { code: "sfo1", label: "San Francisco" },
  { code: "lhr1", label: "London" },
  { code: "cdg1", label: "Paris" },
  { code: "arn1", label: "Stockholm" },
  { code: "dub1", label: "Dublin" },
  { code: "cle1", label: "Cleveland" },
  { code: "pdx1", label: "Portland" },
  { code: "yul1", label: "Montréal" },
  { code: "gru1", label: "Sao Paulo" },
  { code: "sin1", label: "Singapore" },
  { code: "hnd1", label: "Tokyo" },
  { code: "kix1", label: "Osaka" },
  { code: "icn1", label: "Seoul" },
  { code: "hkg1", label: "Hong Kong" },
  { code: "bom1", label: "Mumbai" },
  { code: "syd1", label: "Sydney" },
  { code: "cpt1", label: "Cape Town" },
]

export function regionLabel(code: string): string {
  return REGIONS.find((r) => r.code === code)?.label ?? code
}

/** A Vercel account the user added, by name. */
export interface Account {
  /** Stable id, unique within the plugin's storage. */
  readonly id: string
  /** The name the user gave this account. */
  readonly name: string
  /** Vercel API token. Stored locally, never sent anywhere except Vercel. */
  readonly token: string
  /** Vercel team id the token acts for, when the token has more than one team. */
  readonly teamId?: string
  /** Plan the token's team is on, read at add time. */
  readonly plan?: string
  /** When the account was added. */
  readonly createdAt: number
}

/** An account as reported to clients: never carries the token. */
export interface AccountSummary {
  readonly id: string
  readonly name: string
  readonly plan?: string
  readonly teamId?: string
  readonly createdAt: number
}

export function toAccountSummary(account: Account): AccountSummary {
  return {
    id: account.id,
    name: account.name,
    ...(account.plan ? { plan: account.plan } : {}),
    ...(account.teamId ? { teamId: account.teamId } : {}),
    createdAt: account.createdAt,
  }
}

/** What kind of machinery carries a request. */
export type ExitKind = "relay" | "proxy"

/**
 * What the plugin knows about an exit's ability to serve OpenCode.
 *
 * `reachable` is weaker than `ready`: the endpoint answered, but no model
 * request has proved that OpenCode accepts this exit yet. The distinction is
 * the whole point of the real test, because a relay or proxy can answer a ping
 * and still be refused by OpenCode Free.
 */
export type ExitStatus =
  | "untested"
  | "ready"
  | "reachable"
  | "limited"
  | "exhausted"
  | "blocked"
  | "unreachable"
  | "bad"
  | "unknown"

export const EXIT_STATUS_LABELS: Record<ExitStatus, string> = {
  untested: "not tested",
  ready: "ready",
  reachable: "reachable, not model-tested",
  limited: "rate limited",
  exhausted: "used up",
  blocked: "blocked by OpenCode",
  unreachable: "not answering",
  bad: "failing",
  unknown: "not tested",
}

/** How the terminal UI shows a status, without repeating the rule everywhere. */
export function exitStatusLabel(status: ExitStatus, exhaustedUntil?: number): string {
  if (status === "exhausted" && exhaustedUntil !== undefined) {
    return `used up until ${resetTime(exhaustedUntil)}`
  }
  return EXIT_STATUS_LABELS[status]
}

/** The UTC reset OpenCode's free allowance follows when no countdown is given. */
export function nextResetAt(now = Date.now()): number {
  const date = new Date(now)
  date.setUTCHours(24, 0, 0, 0)
  return date.getTime()
}

/** A moment in words, for a note or a menu. */
export function resetTime(at: number): string {
  return `${new Date(at).toISOString().replace("T", " ").slice(0, 16)} UTC`
}

/** Counters kept for one exit since the process started. Memory is enough. */
export interface ExitStats {
  /** Requests this plugin sent through the exit. */
  readonly requests: number
  /** Answers that carried the request (2xx). */
  readonly ok: number
  /** 409 answers that asked for another instance. */
  readonly rotated: number
  /** 429 answers, whatever their cause. */
  readonly limited: number
  /** Transport failures and 5xx answers. */
  readonly failed: number
  /** The most recent successful round trip, in milliseconds. */
  readonly lastMs?: number
  /** An exponentially weighted average, used by the fastest strategy. */
  readonly averageMs?: number
}

export const EMPTY_STATS: ExitStats = {
  requests: 0,
  ok: 0,
  rotated: 0,
  limited: 0,
  failed: 0,
}

/** The health half of an exit record, shared by relays and proxies. */
export interface ExitHealth {
  /** False when the user paused this exit: it is kept, but not used. */
  readonly enabled: boolean
  readonly status: ExitStatus
  /** When the last check ran. */
  readonly lastCheck?: number
  /** How long the last successful check took. */
  readonly latencyMs?: number
  /** The address the exit last reported it leaves from. */
  readonly egress?: string
  /** The runtime the exit reported, when it says. */
  readonly runtime?: string
  /** Why the last check or request failed, in a short sentence. */
  readonly lastError?: string
  /** When a used-up exit is worth trying again. */
  readonly exhaustedUntil?: number
  readonly createdAt: number
}

/** A relay deployed to Vercel and tracked by this plugin. */
export interface RelayRecord extends ExitHealth {
  readonly kind: "relay"
  readonly id: string
  /** The name the user gave this relay. */
  readonly name: string
  /** Vercel project name. */
  readonly project: string
  /** Vercel region code the relay runs in. */
  readonly region: string
  /** Public URL of the deployed relay. */
  readonly url: string
  /** Access token the relay requires in `x-relay-key`. */
  readonly access: string
  /** Id of the account this relay was deployed with. */
  readonly accountId: string
}

/** An HTTP or SOCKS proxy the user added. */
export interface ProxyRecord extends ExitHealth {
  readonly kind: "proxy"
  readonly id: string
  /** The name the user gave this proxy. */
  readonly name: string
  /** The proxy URL, with its credentials. Stored locally, never leaves the server. */
  readonly url: string
}

/** Either kind of exit, as the routing rules see it. */
export type ExitRecord = RelayRecord | ProxyRecord

/** An exit as reported to clients. Credentials stay on the server. */
export interface ExitSummary {
  readonly id: string
  readonly kind: ExitKind
  readonly name: string
  readonly status: ExitStatus
  readonly statusLabel: string
  readonly enabled: boolean
  /** A URL that is safe to show: a proxy's credentials are removed. */
  readonly url: string
  readonly createdAt: number
  readonly project?: string
  readonly region?: string
  readonly regionLabel?: string
  readonly accountId?: string
  readonly egress?: string
  readonly runtime?: string
  readonly latencyMs?: number
  readonly lastCheck?: number
  readonly exhaustedUntil?: number
  readonly lastError?: string
  readonly stats: ExitStats
}

/** A relay that was just deployed or tracked, as the TUI hears about it. */
export interface DeployedRelay {
  readonly id: string
  readonly name: string
  readonly url: string
  readonly region: string
  readonly regionLabel: string
  readonly reachable: boolean
}

/** The credentials in a proxy URL are never shown, and never sent to the TUI. */
export function displayUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const auth = parsed.username.length > 0 || parsed.password.length > 0 ? "***@" : ""
    return `${parsed.protocol}//${auth}${parsed.hostname}${parsed.port.length > 0 ? `:${parsed.port}` : ""}`
  } catch {
    return "(an address that cannot be read)"
  }
}

export function toExitSummary(
  exit: ExitRecord,
  stats: ExitStats = EMPTY_STATS,
): ExitSummary {
  const common = {
    id: exit.id,
    kind: exit.kind,
    name: exit.name,
    status: exit.status,
    statusLabel: exitStatusLabel(exit.status, exit.exhaustedUntil),
    enabled: exit.enabled,
    createdAt: exit.createdAt,
    ...(exit.egress !== undefined ? { egress: exit.egress } : {}),
    ...(exit.runtime !== undefined ? { runtime: exit.runtime } : {}),
    ...(exit.latencyMs !== undefined ? { latencyMs: exit.latencyMs } : {}),
    ...(exit.lastCheck !== undefined ? { lastCheck: exit.lastCheck } : {}),
    ...(exit.exhaustedUntil !== undefined ? { exhaustedUntil: exit.exhaustedUntil } : {}),
    ...(exit.lastError !== undefined ? { lastError: exit.lastError } : {}),
    stats,
  }
  if (exit.kind === "relay") {
    return {
      ...common,
      url: exit.url,
      project: exit.project,
      region: exit.region,
      regionLabel: regionLabel(exit.region),
      accountId: exit.accountId,
    }
  }
  return { ...common, url: displayUrl(exit.url) }
}

/** Which models are routed through an exit. */
export type Selection = "free" | "custom"

/**
 * How the exits are used.
 *
 * Every exit has an allowance of its own, and so has every address it leaves
 * from. These are the ways to spend them.
 */
export const STRATEGIES = ["fixed", "round-robin", "exhausted", "fastest"] as const

export type Strategy = (typeof STRATEGIES)[number]

/** What a strategy means, in words the user can act on. */
export const STRATEGY_LABELS: Record<
  Strategy,
  { readonly title: string; readonly description: string }
> = {
  fixed: {
    title: "One exit",
    description: "Prefer the exit you chose; when it cannot serve, another takes over",
  },
  "round-robin": {
    title: "Round robin",
    description: "The requests are spread over the exits in turn",
  },
  exhausted: {
    title: "Until it is exhausted",
    description: "One exit is used until its allowance is gone, then the next one",
  },
  fastest: {
    title: "Fastest",
    description: "The exit with the lowest recent latency serves the request",
  },
}

/** What to do when no exit can serve a request. */
export const DIRECT_POLICIES = ["allow", "never"] as const

export type DirectPolicy = (typeof DIRECT_POLICIES)[number]

export const DIRECT_LABELS: Record<
  DirectPolicy,
  { readonly title: string; readonly description: string }
> = {
  allow: {
    title: "Allow direct",
    description: "When no exit can serve, use your own connection",
  },
  never: {
    title: "Never go direct",
    description: "Fail the request instead of spending your own allowance",
  },
}

/** A model of the OpenCode provider, with the free flag the user asked about. */
export interface ModelInfo {
  readonly id: string
  readonly name: string
  /** True when the model costs nothing, i.e. it runs on the free allowance. */
  readonly free: boolean
  /** True when this model is currently routed through an exit. */
  readonly routed: boolean
}

/** Why an exit was skipped, in words the menu can show. */
export interface SkippedExit {
  readonly id: string
  readonly name: string
  readonly kind: ExitKind
  readonly reason: string
}

/** The last routing decision, so the user can see why a request went direct. */
export interface LastDecision {
  readonly at: number
  readonly modelId: string
  readonly routed: boolean
  readonly reason: string
  readonly exitId?: string
  readonly exitName?: string
  readonly kind?: ExitKind
}

/** What a routing preview says, without sending or advancing anything. */
export interface RoutePreview {
  readonly modelId?: string
  readonly routed: boolean
  readonly reason: string
  readonly direct: DirectPolicy
  readonly exit?: ExitSummary
  readonly skipped: readonly SkippedExit[]
}

/** How far a background test run has got. */
export interface ScanProgress {
  readonly startedAt: number
  readonly total: number
  readonly done: number
  readonly kind?: ExitKind
  readonly deep: boolean
}

/** How the plugin is currently routing traffic. */
export interface Status {
  /** False when the plugin is off: requests go direct. */
  readonly enabled: boolean
  readonly selection: Selection
  /** How the exits are used. */
  readonly strategy: Strategy
  /** What happens when no exit can serve. */
  readonly direct: DirectPolicy
  /** Model ids routed when `selection` is `custom`. */
  readonly customModels: readonly string[]
  /** The exit preferred by the one-exit and until-exhausted strategies. */
  readonly activeExit?: ExitSummary
  /** Every relay and proxy, in the order the routing uses them. */
  readonly exits: readonly ExitSummary[]
  /** Accounts available to deploy with. */
  readonly accounts: readonly AccountSummary[]
  /** Exits whose allowance is gone and that have not reached their reset. */
  readonly exhausted: readonly string[]
  /** Exits the user paused. */
  readonly paused: readonly string[]
  /** Exits that are not used right now because they did not answer. */
  readonly skipped: readonly string[]
  /** A background test run in progress, if any. */
  readonly scanning?: ScanProgress
  /** The last request's routing decision. */
  readonly lastDecision?: LastDecision
  /** Last routing note, e.g. why a request went direct. */
  readonly note?: string
}

/** Plan limits, read from the Vercel API. */
export interface PlanLimits {
  /** How many regions one project may run in. */
  readonly regionsPerProject: number
  /** Deployments per day allowed on the plan. */
  readonly deploymentsPerDay: number
  /** Projects allowed on the plan, when the plan caps them. */
  readonly projects?: number
}

/** What a Vercel token can do, read at add time. */
export interface AccountPlan {
  readonly plan: string
  readonly team?: string
  readonly teams: number
  /** How many projects were seen on the first page, which is all one call reads. */
  readonly projectsSampled: number
  /** True when Vercel has more projects than the sampled page held. */
  readonly projectsMore: boolean
  readonly limits?: PlanLimits
}

/** Vercel plan limits, as published by Vercel and mirrored from Polygate. */
export const PLAN_LIMITS: Record<string, PlanLimits> = {
  hobby: { regionsPerProject: 1, deploymentsPerDay: 100, projects: 200 },
  pro: { regionsPerProject: 5, deploymentsPerDay: 6000 },
  enterprise: { regionsPerProject: 99, deploymentsPerDay: 24000 },
}
