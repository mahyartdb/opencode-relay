/**
 * The plugin's own storage: one key per kind of thing.
 *
 * Accounts, relays, proxies and settings are each written under a single key,
 * so a restart finds the same state again without a migration path nobody
 * would remember. What comes back out is checked before it is believed: the
 * storage is a file that may have been edited by hand, and one broken entry
 * must not take the routing down with every other entry.
 */
import { Option, Schema } from "effect"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import type {
  Account,
  DirectPolicy,
  ExitStatus,
  ProxyRecord,
  RelayRecord,
  Selection,
  Strategy,
} from "../lib/types.ts"
import type { Settings } from "./state.ts"

export const ACCOUNTS_KEY = "accounts"
export const RELAYS_KEY = "relays"
export const PROXIES_KEY = "proxies"
export const SETTINGS_KEY = "settings"

/** The stored shape of an account. The token is part of it, and never leaves this plugin. */
const StoredAccount = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  token: Schema.String,
  teamId: Schema.optionalKey(Schema.String),
  plan: Schema.optionalKey(Schema.String),
  createdAt: Schema.Number,
})

/** The statuses an older installation may have written. */
const STATUSES = Schema.Literals([
  "untested",
  "ready",
  "reachable",
  "limited",
  "exhausted",
  "blocked",
  "unreachable",
  "bad",
  "unknown",
])

/** The health fields both kinds of exit share. */
const HealthFields = {
  enabled: Schema.optionalKey(Schema.Boolean),
  status: STATUSES,
  lastCheck: Schema.optionalKey(Schema.Number),
  latencyMs: Schema.optionalKey(Schema.Number),
  egress: Schema.optionalKey(Schema.String),
  runtime: Schema.optionalKey(Schema.String),
  lastError: Schema.optionalKey(Schema.String),
  exhaustedUntil: Schema.optionalKey(Schema.Number),
  // A live failure's rest, written with the status so a restart does not
  // retire the exit all over again. Absent when only a test is on record.
  coolingUntil: Schema.optionalKey(Schema.Number),
  failures: Schema.optionalKey(Schema.Number),
  // Written only while true. Read back missing as "not imported", so an older
  // file loads as if every exit were tested.
  imported: Schema.optionalKey(Schema.Boolean),
  createdAt: Schema.Number,
}

/** The stored shape of a relay. The access token is part of it, and never leaves this plugin. */
const StoredRelay = Schema.Struct({
  kind: Schema.optionalKey(Schema.Literal("relay")),
  id: Schema.String,
  name: Schema.String,
  project: Schema.String,
  region: Schema.String,
  url: Schema.String,
  access: Schema.String,
  accountId: Schema.String,
  // The runtime the relay was deployed with, so a redeploy uses the same one.
  deployRuntime: Schema.optionalKey(Schema.Literals(["bun", "node"])),
  ...HealthFields,
})

/** The stored shape of a proxy. Its URL may carry credentials, and never leaves this plugin. */
const StoredProxy = Schema.Struct({
  kind: Schema.optionalKey(Schema.Literal("proxy")),
  id: Schema.String,
  name: Schema.String,
  url: Schema.String,
  ...HealthFields,
})

/** The stored shape of the routing rules, read one field at a time. */
const SETTINGS_FIELDS = {
  // A file written by hand or by an older version may be missing any of the
  // first three; readSettings fills in what a fresh installation starts with
  // instead of dropping every saved choice.
  enabled: Schema.Boolean,
  selection: Schema.Literals(["all", "free", "custom"]),
  // Written before the strategies existed, so a stored value may not have it.
  strategy: Schema.Literals(["fixed", "round-robin", "exhausted", "fastest"]),
  customModels: Schema.Array(Schema.String),
  // The field was called activeRelayId before proxies existed.
  activeExitId: Schema.String,
  activeRelayId: Schema.String,
  direct: Schema.Literals(["allow", "never"]),
  healthChecks: Schema.Boolean,
  /** Where the round-robin rotation stood, so a restart does not start over. */
  rotationId: Schema.String,
} as const

type StoredHealth = {
  readonly enabled?: boolean
  readonly status: ExitStatus
  readonly lastCheck?: number
  readonly latencyMs?: number
  readonly egress?: string
  readonly runtime?: string
  readonly lastError?: string
  readonly exhaustedUntil?: number
  readonly coolingUntil?: number
  readonly failures?: number
  readonly imported?: boolean
  readonly createdAt: number
}

/** Normalize the status names an older version could write. */
function statusOf(status: ExitStatus): ExitStatus {
  return status === "unknown" ? "untested" : status
}

function healthJson(exit: StoredHealth): Record<string, Schema.Json> {
  const json: Record<string, Schema.Json> = {
    enabled: exit.enabled ?? true,
    status: exit.status,
    createdAt: exit.createdAt,
  }
  if (exit.lastCheck !== undefined) json.lastCheck = exit.lastCheck
  if (exit.latencyMs !== undefined) json.latencyMs = exit.latencyMs
  if (exit.egress !== undefined) json.egress = exit.egress
  if (exit.runtime !== undefined) json.runtime = exit.runtime
  if (exit.lastError !== undefined) json.lastError = exit.lastError
  if (exit.exhaustedUntil !== undefined) json.exhaustedUntil = exit.exhaustedUntil
  if (exit.coolingUntil !== undefined) json.coolingUntil = exit.coolingUntil
  if (exit.failures !== undefined) json.failures = exit.failures
  if (exit.imported === true) json.imported = true
  return json
}

function healthOf(stored: StoredHealth): {
  enabled: boolean
  status: ExitStatus
  createdAt: number
  lastCheck?: number
  latencyMs?: number
  egress?: string
  runtime?: string
  lastError?: string
  exhaustedUntil?: number
  coolingUntil?: number
  failures?: number
  imported?: boolean
} {
  return {
    enabled: stored.enabled ?? true,
    status: statusOf(stored.status),
    createdAt: stored.createdAt,
    ...(stored.lastCheck !== undefined ? { lastCheck: stored.lastCheck } : {}),
    ...(stored.latencyMs !== undefined ? { latencyMs: stored.latencyMs } : {}),
    ...(stored.egress !== undefined ? { egress: stored.egress } : {}),
    ...(stored.runtime !== undefined ? { runtime: stored.runtime } : {}),
    ...(stored.lastError !== undefined ? { lastError: stored.lastError } : {}),
    ...(stored.exhaustedUntil !== undefined ? { exhaustedUntil: stored.exhaustedUntil } : {}),
    ...(stored.coolingUntil !== undefined ? { coolingUntil: stored.coolingUntil } : {}),
    ...(stored.failures !== undefined ? { failures: stored.failures } : {}),
    ...(stored.imported === true ? { imported: true } : {}),
  }
}

/** An account as it is written out, built field by field so nothing unexpected rides along. */
function accountJson(account: Account): Schema.JsonObject {
  const json: Record<string, Schema.Json> = {
    id: account.id,
    name: account.name,
    token: account.token,
    createdAt: account.createdAt,
  }
  if (account.teamId !== undefined) json.teamId = account.teamId
  if (account.plan !== undefined) json.plan = account.plan
  return json
}

/** A relay as it is written out. */
function relayJson(relay: RelayRecord): Schema.JsonObject {
  return {
    kind: "relay",
    id: relay.id,
    name: relay.name,
    project: relay.project,
    region: relay.region,
    url: relay.url,
    access: relay.access,
    accountId: relay.accountId,
    ...(relay.deployRuntime !== undefined ? { deployRuntime: relay.deployRuntime } : {}),
    ...healthJson(relay),
  }
}

/** A proxy as it is written out. */
function proxyJson(proxy: ProxyRecord): Schema.JsonObject {
  return {
    kind: "proxy",
    id: proxy.id,
    name: proxy.name,
    url: proxy.url,
    ...healthJson(proxy),
  }
}

/** The rules as they are written out. */
function settingsJson(settings: Settings): Schema.JsonObject {
  const json: Record<string, Schema.Json> = {
    enabled: settings.enabled,
    selection: settings.selection,
    strategy: settings.strategy,
    customModels: [...settings.customModels],
    direct: settings.direct,
    healthChecks: settings.healthChecks,
  }
  if (settings.activeExitId !== undefined) json.activeExitId = settings.activeExitId
  if (settings.rotationId !== undefined) json.rotationId = settings.rotationId
  return json
}

/** Read one account, or nothing when the stored value does not make sense. */
function decodeAccount(value: unknown): Account | undefined {
  const decoded = Schema.decodeUnknownOption(StoredAccount)(value)
  if (Option.isNone(decoded)) return undefined
  const account = decoded.value
  return {
    id: account.id,
    name: account.name,
    token: account.token,
    ...(account.teamId !== undefined ? { teamId: account.teamId } : {}),
    ...(account.plan !== undefined ? { plan: account.plan } : {}),
    createdAt: account.createdAt,
  }
}

/** Read one relay, or nothing when the stored value does not make sense. */
function decodeRelay(value: unknown): RelayRecord | undefined {
  const decoded = Schema.decodeUnknownOption(StoredRelay)(value)
  if (Option.isNone(decoded)) return undefined
  const relay = decoded.value
  return {
    kind: "relay",
    id: relay.id,
    name: relay.name,
    project: relay.project,
    region: relay.region,
    url: relay.url,
    access: relay.access,
    accountId: relay.accountId,
    ...(relay.deployRuntime !== undefined ? { deployRuntime: relay.deployRuntime } : {}),
    ...healthOf(relay),
  }
}

/** Read one proxy, or nothing when the stored value does not make sense. */
function decodeProxy(value: unknown): ProxyRecord | undefined {
  const decoded = Schema.decodeUnknownOption(StoredProxy)(value)
  if (Option.isNone(decoded)) return undefined
  const proxy = decoded.value
  return {
    kind: "proxy",
    id: proxy.id,
    name: proxy.name,
    url: proxy.url,
    ...healthOf(proxy),
  }
}

/** The stored accounts, keeping the ones that still make sense and dropping the rest. */
export async function readAccounts(storage: StorageDomain): Promise<Account[]> {
  const raw = await storage.get(ACCOUNTS_KEY)
  if (!Array.isArray(raw)) return []
  const accounts: Account[] = []
  for (const entry of raw) {
    const account = decodeAccount(entry)
    if (account) accounts.push(account)
  }
  return accounts
}

/** The stored relays, keeping the ones that still make sense and dropping the rest. */
export async function readRelays(storage: StorageDomain): Promise<RelayRecord[]> {
  const raw = await storage.get(RELAYS_KEY)
  if (!Array.isArray(raw)) return []
  const relays: RelayRecord[] = []
  for (const entry of raw) {
    const relay = decodeRelay(entry)
    if (relay) relays.push(relay)
  }
  return relays
}

/** The stored proxies, keeping the ones that still make sense and dropping the rest. */
export async function readProxies(storage: StorageDomain): Promise<ProxyRecord[]> {
  const raw = await storage.get(PROXIES_KEY)
  if (!Array.isArray(raw)) return []
  const proxies: ProxyRecord[] = []
  for (const entry of raw) {
    const proxy = decodeProxy(entry)
    if (proxy) proxies.push(proxy)
  }
  return proxies
}

/**
 * The stored rules, or nothing when there are none yet.
 *
 * A file that exists but does not make sense is read field by field, so one
 * wrong value cannot take every other saved choice with it. Only such a file
 * is reported: a fresh installation has no file, and nothing is wrong.
 */
export async function readSettings(
  storage: StorageDomain,
  note?: (message: string) => void,
): Promise<Settings | undefined> {
  const raw = await storage.get(SETTINGS_KEY)
  if (raw === undefined) return undefined
  const stored =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined
  const broken: string[] = []
  const field = <A>(key: string, schema: Schema.ConstraintDecoder<A>): A | undefined => {
    const value = stored?.[key]
    if (value === undefined) return undefined
    const decoded = Schema.decodeUnknownOption(schema)(value)
    if (Option.isSome(decoded)) return decoded.value
    broken.push(key)
    return undefined
  }
  const enabled = field("enabled", SETTINGS_FIELDS.enabled)
  const selection = field("selection", SETTINGS_FIELDS.selection)
  const strategy = field("strategy", SETTINGS_FIELDS.strategy)
  const customModels = field("customModels", SETTINGS_FIELDS.customModels)
  const activeExitId =
    field("activeExitId", SETTINGS_FIELDS.activeExitId) ??
    field("activeRelayId", SETTINGS_FIELDS.activeRelayId)
  const direct = field("direct", SETTINGS_FIELDS.direct)
  const healthChecks = field("healthChecks", SETTINGS_FIELDS.healthChecks)
  const rotationId = field("rotationId", SETTINGS_FIELDS.rotationId)
  if (stored === undefined) {
    note?.(
      "The stored routing rules are not an object, so their defaults were used. Saving the rules again replaces the file.",
    )
  } else if (broken.length > 0) {
    note?.(
      `The stored routing rules could not be read in full: ${broken.join(", ")} had the wrong shape, so their defaults were used. Saving the rules again replaces the file.`,
    )
  }
  return {
    enabled: enabled ?? false,
    // "all" predates the free-only rule. It is read as "free", which is what
    // the plugin would have routed anyway once paid models were filtered out.
    selection: (selection === "all" ? "free" : (selection ?? "free")) as Selection,
    strategy: (strategy ?? "fixed") as Strategy,
    customModels: [...(customModels ?? [])],
    direct: (direct ?? "allow") as DirectPolicy,
    healthChecks: healthChecks ?? true,
    ...(activeExitId !== undefined ? { activeExitId } : {}),
    ...(rotationId !== undefined ? { rotationId } : {}),
  }
}

/** Write the accounts back. */
export async function writeAccounts(storage: StorageDomain, accounts: readonly Account[]): Promise<void> {
  await storage.set(ACCOUNTS_KEY, accounts.map((account) => accountJson(account)))
}

/** Write the relays back. */
export async function writeRelays(storage: StorageDomain, relays: readonly RelayRecord[]): Promise<void> {
  await storage.set(RELAYS_KEY, relays.map((relay) => relayJson(relay)))
}

/** Write the proxies back. */
export async function writeProxies(storage: StorageDomain, proxies: readonly ProxyRecord[]): Promise<void> {
  await storage.set(PROXIES_KEY, proxies.map((proxy) => proxyJson(proxy)))
}

/** Write the rules back. */
export async function writeSettings(storage: StorageDomain, settings: Settings): Promise<void> {
  await storage.set(SETTINGS_KEY, settingsJson(settings))
}
