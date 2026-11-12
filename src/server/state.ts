/**
 * The truth the server keeps: the accounts, the relays and the routing rules.
 *
 * Everything the plugin remembers lives here, and every change is written back
 * to the plugin's storage, so a restart finds the same relays again. The Vercel
 * token and the relay access token stay in this process: they are the reason
 * this file sits below the RPC layer, which only ever reports summaries.
 */
import { randomUUID } from "node:crypto"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import type { Account, Relay, Selection } from "../lib/types.ts"
import {
  readAccounts,
  readRelays,
  readSettings,
  writeAccounts,
  writeRelays,
  writeSettings,
} from "./storage.ts"

/** What the plugin is currently routing, and how. */
export interface Settings {
  /** False when the plugin is off: requests go straight to OpenCode. */
  readonly enabled: boolean
  /** Which models are routed through the relay. */
  readonly selection: Selection
  /** Model ids routed when `selection` is `custom`. */
  readonly customModels: string[]
  /** The relay in use, if any. */
  readonly activeRelayId?: string
}

/**
 * The rules a fresh installation starts with.
 *
 * The plugin starts off, so a fresh installation changes nothing, and it starts
 * with the free models, because those are the ones the relay can carry.
 */
const DEFAULT_SETTINGS: Settings = {
  enabled: false,
  selection: "free",
  customModels: [],
}

/** A new account, before it is stored. */
export interface NewAccount {
  readonly name: string
  readonly token: string
  readonly teamId?: string
  readonly plan?: string
}

/**
 * The plugin's state, in memory and on disk.
 *
 * The class owns the rules for when traffic is routed, so the hooks and the RPC
 * handlers read the same truth instead of each keeping their own copy.
 */
export class RelayState {
  private readonly storage: StorageDomain
  private accountList: Account[] = []
  private relayList: Relay[] = []
  private rules: Settings = { ...DEFAULT_SETTINGS, customModels: [] }
  /** The addresses whose free allowance is gone, per relay. Memory is enough: they expire with the process. */
  private readonly spent = new Map<string, Set<string>>()

  constructor(storage: StorageDomain) {
    this.storage = storage
  }

  /** Read what the last run left behind, before anything is allowed to route. */
  async load(): Promise<void> {
    const [accounts, relays, settings] = await Promise.all([
      readAccounts(this.storage),
      readRelays(this.storage),
      readSettings(this.storage),
    ])
    this.accountList = accounts
    this.relayList = relays
    this.rules = settings ?? { ...DEFAULT_SETTINGS, customModels: [] }
    // An active relay that is gone would send traffic nowhere, so the setting goes with it.
    const active = this.rules.activeRelayId
    if (active !== undefined && !this.relayList.some((relay) => relay.id === active)) {
      this.rules = { ...this.rules, activeRelayId: undefined }
    }
  }

  /** The stored accounts. */
  accounts(): readonly Account[] {
    return this.accountList
  }

  /** The stored relays. */
  relays(): readonly Relay[] {
    return this.relayList
  }

  /** The routing rules as they stand. */
  settings(): Settings {
    return this.rules
  }

  /** The account with this id, if it is still there. */
  account(id: string): Account | undefined {
    return this.accountList.find((account) => account.id === id)
  }

  /** The relay with this id, if it is still there. */
  relay(id: string): Relay | undefined {
    return this.relayList.find((relay) => relay.id === id)
  }

  /** The relay traffic goes through, when one is picked and still exists. */
  activeRelay(): Relay | undefined {
    const id = this.rules.activeRelayId
    if (id === undefined) return undefined
    return this.relayList.find((relay) => relay.id === id)
  }

  /** Store an account. The token stays here and goes nowhere else. */
  async addAccount(input: NewAccount): Promise<Account> {
    const account: Account = {
      id: randomUUID(),
      name: input.name,
      token: input.token,
      ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
      ...(input.plan !== undefined ? { plan: input.plan } : {}),
      createdAt: Date.now(),
    }
    this.accountList = [...this.accountList, account]
    await writeAccounts(this.storage, this.accountList)
    return account
  }

  /** Forget an account. The relays it deployed stay: they run on their own. */
  async removeAccount(id: string): Promise<boolean> {
    const kept = this.accountList.filter((account) => account.id !== id)
    if (kept.length === this.accountList.length) return false
    this.accountList = kept
    await writeAccounts(this.storage, this.accountList)
    return true
  }

  /** Store a relay. */
  async addRelay(relay: Relay): Promise<Relay> {
    this.relayList = [...this.relayList, relay]
    await writeRelays(this.storage, this.relayList)
    return relay
  }

  /** Record whether the relay answered its last check. Says whether anything changed. */
  async setRelayStatus(id: string, status: Relay["status"]): Promise<boolean> {
    const current = this.relayList.find((relay) => relay.id === id)
    if (!current || current.status === status) return false
    this.relayList = this.relayList.map((relay) => (relay.id === id ? { ...relay, status } : relay))
    await writeRelays(this.storage, this.relayList)
    return true
  }

  /** Forget a relay, and stop routing through it when it was the active one. */
  async removeRelay(id: string): Promise<Relay | undefined> {
    const relay = this.relayList.find((entry) => entry.id === id)
    if (!relay) return undefined
    this.relayList = this.relayList.filter((entry) => entry.id !== id)
    this.spent.delete(id)
    if (this.rules.activeRelayId === id) {
      this.rules = { ...this.rules, activeRelayId: undefined }
    }
    await writeRelays(this.storage, this.relayList)
    await writeSettings(this.storage, this.rules)
    return relay
  }

  /** Turn the routing on or off. */
  async setEnabled(enabled: boolean): Promise<void> {
    this.rules = { ...this.rules, enabled }
    await writeSettings(this.storage, this.rules)
  }

  /** Choose which models are routed. Without a list, the custom one is kept as it is. */
  async setSelection(selection: Selection, models?: readonly string[]): Promise<Settings> {
    this.rules = {
      ...this.rules,
      selection,
      customModels: models === undefined ? [...this.rules.customModels] : [...models],
    }
    await writeSettings(this.storage, this.rules)
    return this.rules
  }

  /** Pick the relay traffic goes through, or none at all. */
  async setActiveRelay(id: string | undefined): Promise<void> {
    this.rules = { ...this.rules, activeRelayId: id }
    await writeSettings(this.storage, this.rules)
  }

  /** Remember an address whose free allowance is gone, so the relay skips it from now on. */
  markSpent(relayId: string, egress: string): void {
    const addresses = this.spent.get(relayId) ?? new Set<string>()
    addresses.add(egress)
    this.spent.set(relayId, addresses)
  }

  /** The addresses the relay should not send from. */
  spentEgresses(relayId: string): string[] {
    return [...(this.spent.get(relayId) ?? new Set<string>())]
  }
}
