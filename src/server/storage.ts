/**
 * The plugin's own storage: one key per kind of thing.
 *
 * Accounts, relays and settings are each written under a single key, so a
 * restart finds the same state again without a migration path nobody would
 * remember. What comes back out is checked before it is believed: the storage
 * is a file that may have been edited by hand, and one broken account must not
 * take the routing down with every other account.
 */
import { Option, Schema } from "effect"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import type { Account, RelayRecord } from "../lib/types.ts"
import type { Settings } from "./state.ts"

export const ACCOUNTS_KEY = "accounts"
export const RELAYS_KEY = "relays"
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

/** The stored shape of a relay. The access token is part of it, and never leaves this plugin. */
const StoredRelay = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  project: Schema.String,
  region: Schema.String,
  url: Schema.String,
  access: Schema.String,
  accountId: Schema.String,
  status: Schema.Literals(["ready", "unreachable", "unknown"]),
  createdAt: Schema.Number,
})

/** The stored shape of the routing rules. */
const StoredSettings = Schema.Struct({
  enabled: Schema.Boolean,
  selection: Schema.Literals(["all", "free", "custom"]),
  // Written before the strategies existed, so a stored value may not have it.
  // Reading it as optional keeps an older installation's rules intact.
  strategy: Schema.optionalKey(Schema.Literals(["fixed", "round-robin", "exhausted"])),
  customModels: Schema.Array(Schema.String),
  activeRelayId: Schema.optionalKey(Schema.String),
})

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
  const json: Record<string, Schema.Json> = {
    id: relay.id,
    name: relay.name,
    project: relay.project,
    region: relay.region,
    url: relay.url,
    access: relay.access,
    accountId: relay.accountId,
    status: relay.status,
    createdAt: relay.createdAt,
  }
  return json
}

/** The rules as they are written out. */
function settingsJson(settings: Settings): Schema.JsonObject {
  const json: Record<string, Schema.Json> = {
    enabled: settings.enabled,
    selection: settings.selection,
    strategy: settings.strategy ?? "fixed",
    customModels: [...settings.customModels],
  }
  if (settings.activeRelayId !== undefined) json.activeRelayId = settings.activeRelayId
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
    id: relay.id,
    name: relay.name,
    project: relay.project,
    region: relay.region,
    url: relay.url,
    access: relay.access,
    accountId: relay.accountId,
    status: relay.status,
    createdAt: relay.createdAt,
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

/** The stored rules, or nothing when there are none yet. */
export async function readSettings(storage: StorageDomain): Promise<Settings | undefined> {
  const raw = await storage.get(SETTINGS_KEY)
  const decoded = Schema.decodeUnknownOption(StoredSettings)(raw)
  if (Option.isNone(decoded)) return undefined
  const settings = decoded.value
  // The strategy was added after the first release, so an older stored value
  // has none and starts on the fixed relay.
  return {
    enabled: settings.enabled,
    selection: settings.selection,
    strategy: settings.strategy ?? "fixed",
    customModels: [...settings.customModels],
    ...(settings.activeRelayId !== undefined ? { activeRelayId: settings.activeRelayId } : {}),
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

/** Write the rules back. */
export async function writeSettings(storage: StorageDomain, settings: Settings): Promise<void> {
  await storage.set(SETTINGS_KEY, settingsJson(settings))
}
