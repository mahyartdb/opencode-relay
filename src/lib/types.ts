/**
 * Shared shapes for the relay plugin.
 *
 * The server part owns the truth (accounts, relays, routing rules). The TUI
 * part only ever reads and writes through the RPC contract in `rpc.ts`, so
 * both sides agree on these types without importing each other.
 */

export const PROVIDER_ID = "opencode"

/** The upstream the relay forwards to. */
export const UPSTREAM_HOST = "opencode.ai"

/** Default path prefix OpenCode Free serves inference under. */
export const UPSTREAM_BASE = "https://opencode.ai/inference/openai/v1"

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
  { code: "gru1", label: "São Paulo" },
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

/** A relay deployed to Vercel and tracked by this plugin. */
export interface RelayRecord {
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
  /** Whether the relay answered the last check. */
  readonly status: "ready" | "unreachable" | "unknown"
  readonly createdAt: number
}

/** A relay as reported to clients. The access token stays on the server. */
export interface RelaySummary {
  readonly id: string
  readonly name: string
  readonly project: string
  readonly region: string
  readonly regionLabel: string
  readonly url: string
  readonly accountId: string
  readonly status: RelayRecord["status"]
  readonly createdAt: number
}

export function toRelaySummary(relay: RelayRecord): RelaySummary {
  return {
    id: relay.id,
    name: relay.name,
    project: relay.project,
    region: relay.region,
    regionLabel: regionLabel(relay.region),
    url: relay.url,
    accountId: relay.accountId,
    status: relay.status,
    createdAt: relay.createdAt,
  }
}

/** Which models are routed through a relay. */
export type Selection = "all" | "free" | "custom"

/** A model of the OpenCode provider, with the free flag the user asked about. */
export interface ModelInfo {
  readonly id: string
  readonly name: string
  /** True when the model costs nothing, i.e. it runs on the free allowance. */
  readonly free: boolean
  /** True when this model is currently routed through a relay. */
  readonly routed: boolean
}

/** How the plugin is currently routing traffic. */
export interface Status {
  /** False when the plugin is off: requests go direct. */
  readonly enabled: boolean
  readonly selection: Selection
  /** Model ids routed when `selection` is `custom`. */
  readonly customModels: readonly string[]
  /** The relay currently in use, if any. */
  readonly activeRelay?: RelaySummary
  /** Relays available to switch to. */
  readonly relays: readonly RelaySummary[]
  /** Accounts available to deploy with. */
  readonly accounts: readonly AccountSummary[]
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
  readonly projects: number
  readonly projectsMore: boolean
  readonly limits?: PlanLimits
}

/** Vercel plan limits, as published by Vercel and mirrored from Polygate. */
export const PLAN_LIMITS: Record<string, PlanLimits> = {
  hobby: { regionsPerProject: 1, deploymentsPerDay: 100, projects: 200 },
  pro: { regionsPerProject: 5, deploymentsPerDay: 6000 },
  enterprise: { regionsPerProject: 99, deploymentsPerDay: 24000 },
}
