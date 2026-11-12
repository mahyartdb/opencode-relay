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
import type { Account, RelayRecord, Selection, Strategy } from "../lib/types.ts"
import { nextRelay } from "../lib/routing.ts"
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
  /** How the relays are used. */
  readonly strategy: Strategy
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
  strategy: "fixed",
  customModels: [],
}

/** How long a relay that did not answer is left alone before it is tried again. */
export const RELAY_COOLDOWN_MS = 60_000

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
  private relayList: RelayRecord[] = []
  private rules: Settings = { ...DEFAULT_SETTINGS, customModels: [] }
  /** The addresses whose free allowance is gone, per relay. Memory is enough: they expire with the process. */
  private readonly spent = new Map<string, Set<string>>()
  /** What the user has to be told about. */
  private notes_: string[] = []
  /** The relays whose allowance is gone. */
  private readonly exhausted = new Set<string>()
  /** Where the last request went, for the strategy that moves on each time. */
  private cursor = 0
  /** Why an address was marked as spent, when the provider said why. */
  private readonly spendReasons = new Map<string, string>()
  /** Requests that went through a relay, so a retry knows a failure came from one. */
  private readonly relayed = new Map<
    string,
    { readonly at: number; readonly relayId: string }
  >()
  /**
   * Relays that did not answer, and the moment they may be tried again.
   *
   * A relay that cannot be reached is skipped for a while rather than failing
   * every request in the session. The wait is not written down: a dropped
   * connection or a sleeping laptop is not a lasting fact about the relay.
   */
  private readonly cooling = new Map<string, number>()

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
    // An active relay that is gone would leave the menu without one to test or
    // update, so the first relay takes its place. With no relay at all, there is
    // nothing to choose.
    const active = this.rules.activeRelayId
    const kept = active !== undefined && this.relayList.some((relay) => relay.id === active)
    if (!kept && this.relayList.length > 0) {
      this.rules = { ...this.rules, activeRelayId: this.relayList[0]?.id }
    }
  }

  /** The stored accounts. */
  accounts(): readonly Account[] {
    return this.accountList
  }

  /** The stored relays. */
  relays(): readonly RelayRecord[] {
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
  relay(id: string): RelayRecord | undefined {
    return this.relayList.find((relay) => relay.id === id)
  }

  /** The relay traffic goes through, when one is picked and still exists. */
  activeRelay(): RelayRecord | undefined {
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
  async addRelay(relay: RelayRecord): Promise<RelayRecord> {
    this.relayList = [...this.relayList, relay]
    await writeRelays(this.storage, this.relayList)
    // A plugin with one relay and no choice would report "no relay" while a
    // relay sits right there, so the first one becomes the chosen one.
    if (this.rules.activeRelayId === undefined) {
      this.rules = { ...this.rules, activeRelayId: relay.id }
      await writeSettings(this.storage, this.rules)
    }
    return relay
  }

  /** Record whether the relay answered its last check. Says whether anything changed. */
  async setRelayStatus(id: string, status: RelayRecord["status"]): Promise<boolean> {
    const current = this.relayList.find((relay) => relay.id === id)
    if (!current) return false
    // A relay that answers a check is tried again at once, even when a request
    // failed to reach it a moment ago.
    if (status === "ready") this.cooling.delete(id)
    if (current.status === status) return false
    this.relayList = this.relayList.map((relay) => (relay.id === id ? { ...relay, status } : relay))
    await writeRelays(this.storage, this.relayList)
    return true
  }

  /** Forget a relay, and stop routing through it when it was the active one. */
  async removeRelay(id: string): Promise<RelayRecord | undefined> {
    const relay = this.relayList.find((entry) => entry.id === id)
    if (!relay) return undefined
    this.relayList = this.relayList.filter((entry) => entry.id !== id)
    this.spent.delete(id)
    this.exhausted.delete(id)
    this.cooling.delete(id)
    if (this.rules.activeRelayId === id) {
      // The next relay takes the place of the one that is gone, so the menu
      // and the footer still have a relay to name and to test.
      this.rules = { ...this.rules, activeRelayId: this.relayList[0]?.id }
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
    // In round robin, choosing a relay means starting the rotation there.
    const index = id === undefined ? -1 : this.relayList.findIndex((relay) => relay.id === id)
    if (this.rules.strategy === "round-robin" && index >= 0) this.cursor = index
    await writeSettings(this.storage, this.rules)
  }

  /**
   * Something the user should know about, shown in the status note.
   *
   * A failure that is only written to a log is a failure the user never learns
   * about, and a project left running because a deletion failed is worth
   * saying out loud.
   */
  noteFailure(message: string): void {
    this.notes_ = [...this.notes_, message]
  }

  /** The things the user should be told about, newest last. */
  notes(): readonly string[] {
    return this.notes_
  }

  /** Why an address was marked as spent, when the provider said. */
  noteSpendReason(egress: string, body: string): void {
    this.spendReasons.set(egress, body.slice(0, 200))
  }

  /** Why an address was marked as spent, when the provider said. */
  spendReason(egress: string): string | undefined {
    return this.spendReasons.get(egress)
  }

  /** Whether a relay may serve a request now. */
  private usable(relay: RelayRecord, now = Date.now()): boolean {
    // A relay that failed its last check is skipped until it is checked again,
    // and one that just did not answer is left alone for a short while.
    if (relay.status === "unreachable") return false
    const until = this.cooling.get(relay.id)
    return until === undefined || until <= now
  }

  /**
   * The relay that serves the next request.
   *
   * The strategy decides: one relay always, one request each in turn, or one
   * until it is used up. A relay that is known not to answer never serves a
   * request: the session keeps working by going direct instead.
   */
  pickRelay(): RelayRecord | undefined {
    const now = Date.now()
    const usable = this.relayList.filter((relay) => this.usable(relay, now))
    if (usable.length === 0) return undefined
    if (this.rules.strategy === "fixed") {
      // One relay means one relay. When the chosen one cannot serve, the
      // request goes direct rather than quietly spending another allowance.
      // With no choice stored, the first relay is the sensible default.
      if (this.rules.activeRelayId === undefined) return usable[0]
      return usable.find((relay) => relay.id === this.rules.activeRelayId)
    }
    const { relay, cursor } = nextRelay(usable, {
      strategy: this.rules.strategy,
      ...(this.rules.activeRelayId !== undefined ? { activeId: this.rules.activeRelayId } : {}),
      cursor: this.cursor,
      exhausted: this.exhausted,
    })
    this.cursor = cursor
    return relay
  }

  /**
   * Remember that a relay did not answer.
   *
   * The next request skips it, so one unreachable relay cannot take a whole
   * session down. It is tried again after RELAY_COOLDOWN_MS, because most
   * failures to reach a relay are temporary.
   */
  markRelayFailure(id: string): void {
    this.cooling.set(id, Date.now() + RELAY_COOLDOWN_MS)
  }

  /** The relays being skipped because they did not answer. */
  coolingRelays(): readonly string[] {
    const now = Date.now()
    return [...this.cooling]
      .filter(([id, until]) => until > now && this.relay(id) !== undefined)
      .map(([id]) => id)
  }

  /**
   * A relay whose allowance is gone.
   *
   * With the strategy that uses a relay until it is exhausted, the choice moves
   * on to the next relay here.
   */
  markExhausted(relayId: string): void {
    if (this.exhausted.has(relayId)) return
    this.exhausted.add(relayId)
    if (this.rules.strategy !== "exhausted") return
    if (this.rules.activeRelayId !== relayId) return
    // The next relay in the list order takes over, wrapping at the end.
    const index = this.relayList.findIndex((relay) => relay.id === relayId)
    let next: RelayRecord | undefined
    for (let step = 1; step <= this.relayList.length; step++) {
      const candidate = this.relayList[(index + step) % this.relayList.length]
      if (candidate && candidate.id !== relayId && !this.exhausted.has(candidate.id)) {
        next = candidate
        break
      }
    }
    if (!next) return
    this.rules = { ...this.rules, activeRelayId: next.id }
    // The answer is already on its way, so a failed write is noted rather than
    // thrown: the traffic keeps moving, and the user learns what went wrong.
    void writeSettings(this.storage, this.rules).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      this.noteFailure(`The next relay could not be remembered: ${message}`)
    })
  }

  /** The relays whose allowance is gone. */
  exhaustedRelays(): readonly string[] {
    return [...this.exhausted]
  }

  /** Bring the used-up relays back into use. */
  restoreExhausted(): string[] {
    const restored = [...this.exhausted]
    this.exhausted.clear()
    this.cursor = 0
    return restored
  }

  /** Choose how the relays are used. */
  async setStrategy(strategy: Strategy): Promise<void> {
    this.rules = { ...this.rules, strategy }
    // Round robin starts at the relay the user chose, so switching to it does
    // not silently move the first request somewhere else.
    const index =
      this.rules.activeRelayId === undefined
        ? -1
        : this.relayList.findIndex((relay) => relay.id === this.rules.activeRelayId)
    this.cursor = strategy === "round-robin" && index >= 0 ? index : 0
    await writeSettings(this.storage, this.rules)
  }

  /**
   * Remember that a request for this session and model went through a relay.
   *
   * The retry hook is not told which request failed, so the request hook leaves
   * this note and the retry hook reads it. Entries are short lived: a retry
   * happens within seconds, and anything older is not this failure.
   */
  noteRelayed(sessionID: string, modelID: string, relayId: string): void {
    const now = Date.now()
    if (this.relayed.size > 200) {
      for (const [key, entry] of this.relayed) {
        if (now - entry.at > 60_000) this.relayed.delete(key)
      }
    }
    this.relayed.set(`${sessionID}\u0000${modelID}`, { at: now, relayId })
  }

  /** Which relay served this session and model a moment ago, if one did. */
  relayedBy(sessionID: string, modelID: string): string | undefined {
    const entry = this.relayed.get(`${sessionID}\u0000${modelID}`)
    if (entry === undefined || Date.now() - entry.at > 60_000) return undefined
    return entry.relayId
  }

  /** Whether a request for this session and model recently went through a relay. */
  wasRelayed(sessionID: string, modelID: string): boolean {
    return this.relayedBy(sessionID, modelID) !== undefined
  }

  /**
   * Whether another attempt after a used-up answer can reach an address that
   * still works.
   *
   * The one-relay strategy keeps its relay, but the relay still drops the
   * address that is spent and answers from another, so another attempt is
   * worth making. The moving strategies need a relay that is not used up,
   * because the next attempt goes to one of those.
   */
  canRetryAfterAllowance(): boolean {
    if (this.relayList.length === 0) return false
    const now = Date.now()
    if (this.rules.strategy === "fixed") {
      const active = this.activeRelay()
      return active !== undefined && this.usable(active, now)
    }
    return this.relayList.some(
      (relay) => !this.exhausted.has(relay.id) && this.usable(relay, now),
    )
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
