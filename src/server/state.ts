/**
 * The truth the server keeps: the accounts, the exits and the routing rules.
 *
 * Everything the plugin remembers lives here, and every lasting change is
 * written back to the plugin's storage, so a restart finds the same exits
 * again. The Vercel token and the relay access token stay in this process: they
 * are the reason this file sits below the RPC layer, which only ever reports
 * summaries.
 *
 * The important unit is the *exit*, not the machinery. A relay and a proxy are
 * both exits, they can both run out of allowance, and the strategy chooses
 * among them in one list. A used-up exit gets a reset time, is skipped while it
 * waits, and comes back on its own when the reset passes.
 */
import { randomUUID } from "node:crypto"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import type {
  Account,
  DirectPolicy,
  ExitRecord,
  ExitStats,
  ExitStatus,
  LastDecision,
  ProxyRecord,
  RelayRecord,
  ScanProgress,
  Selection,
  SkippedExit,
  Strategy,
} from "../lib/types.ts"
import {
  EMPTY_STATS,
  resetTime,
  type ExitStatus as Status,
  type ExitSummary,
  toExitSummary,
} from "../lib/types.ts"
import { nextExit } from "../lib/routing.ts"
import {
  readAccounts,
  readProxies,
  readRelays,
  readSettings,
  writeAccounts,
  writeProxies,
  writeRelays,
  writeSettings,
} from "./storage.ts"

/** What the plugin is currently routing, and how. */
export interface Settings {
  /** False when the plugin is off: requests go straight to OpenCode. */
  readonly enabled: boolean
  /** Which models are routed through an exit. Only free models are ever used. */
  readonly selection: Selection
  /** How the exits are used. */
  readonly strategy: Strategy
  /** What happens when no exit can serve a request. */
  readonly direct: DirectPolicy
  /** Model ids routed when `selection` is `custom`. */
  readonly customModels: string[]
  /** The exit preferred by the one-exit and until-exhausted strategies. */
  readonly activeExitId?: string
  /** Whether the server checks exits in the background. */
  readonly healthChecks: boolean
}

/**
 * The rules a fresh installation starts with.
 *
 * The plugin starts off, so a fresh installation changes nothing, and it starts
 * with the free models, because those are the ones the exits can carry.
 */
const DEFAULT_SETTINGS: Settings = {
  enabled: false,
  selection: "free",
  strategy: "fixed",
  direct: "allow",
  customModels: [],
  healthChecks: true,
}

/** How long a failing exit is left alone before it is tried again. */
export const COOLDOWN_BASE_MS = 2 * 60_000

/** The longest a failing exit is left alone. */
export const COOLDOWN_MAX_MS = 30 * 60_000

/** How long an unconfirmed refusal is left alone. */
export const REFUSED_COOLDOWN_MS = 15 * 60_000

/** How long a short rate limit is left alone. */
export const RATE_LIMIT_COOLDOWN_MS = 60_000

/** A sample of a real OpenCode request, kept in memory so a test can look like one. */
export interface RequestSample {
  readonly at: number
  readonly modelID: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
}

/** Why a request failed, as the retry hook needs to know it. */
export interface FailureContext {
  readonly at: number
  readonly exitId: string
  readonly kind:
    | "rotate"
    | "exhausted"
    | "rate-limited"
    | "refused"
    | "server"
    | "transport"
    | "blocked"
  /** True when the upstream answered through the exit (so the exit itself worked). */
  readonly reached: boolean
  readonly until?: number
  readonly note?: string
}

/** A new account, before it is stored. */
export interface NewAccount {
  readonly name: string
  readonly token: string
  readonly teamId?: string
  readonly plan?: string
}

/** What a ping or a test found, ready to be written into a record. */
export interface HealthUpdate {
  readonly status: ExitStatus
  readonly latencyMs?: number
  readonly egress?: string
  readonly runtime?: string
  readonly lastError?: string
  readonly exhaustedUntil?: number
  readonly checkedAt?: number
}

/** One exit with its skip reason, for a preview. */
export interface PickResult {
  readonly exit?: ExitRecord
  readonly skipped: readonly SkippedExit[]
  readonly reason: string
}

/** What the plugin knows about one exit, in memory and on disk. */
export class RelayState {
  private readonly storage: StorageDomain
  private accountList: Account[] = []
  private relayList: RelayRecord[] = []
  private proxyList: ProxyRecord[] = []
  private rules: Settings = { ...DEFAULT_SETTINGS, customModels: [] }
  /** The addresses whose free allowance is gone, with the moment they return. */
  private readonly spent = new Map<string, number>()
  /** What the user has to be told about. */
  private notes_: string[] = []
  /** Where the last request went, for the strategy that moves on each time. */
  private cursor = 0
  /** Why an address was marked as spent, when the provider said why. */
  private readonly spendReasons = new Map<string, string>()
  /** Exits that did not answer, and how many times in a row. */
  private readonly cooling = new Map<string, { until: number; failures: number }>()
  /** Requests and answers seen through each exit since the process started. */
  private readonly stats = new Map<string, ExitStats>()
  /** Requests that went through an exit, so a retry knows a failure came from one. */
  private readonly relayed = new Map<string, { readonly at: number; readonly exitId: string }>()
  /** When each routed request started, so the answer can be timed. */
  private readonly started = new Map<string, number>()
  /** What the last answer said, so the retry hook does not have to guess. */
  private readonly failures = new Map<string, FailureContext>()
  /** The last real request, so a test can send the headers OpenCode Free expects. */
  private sample: RequestSample | undefined
  private lastDecision_: LastDecision | undefined
  private scanning_: ScanProgress | undefined

  constructor(storage: StorageDomain) {
    this.storage = storage
  }

  /** Read what the last run left behind, before anything is allowed to route. */
  async load(): Promise<void> {
    const [accounts, relays, proxies, settings] = await Promise.all([
      readAccounts(this.storage),
      readRelays(this.storage),
      readProxies(this.storage),
      readSettings(this.storage),
    ])
    this.accountList = accounts
    this.relayList = relays.map((relay) => this.fresh(relay))
    this.proxyList = proxies.map((proxy) => this.fresh(proxy))
    this.rules = settings ?? { ...DEFAULT_SETTINGS, customModels: [] }
    const expired = [...this.relayList, ...this.proxyList].some(
      (exit) => exit.status === "exhausted" && (exit.exhaustedUntil ?? 0) <= Date.now(),
    )
    if (expired) {
      this.relayList = this.relayList.map((relay) => this.fresh(relay))
      this.proxyList = this.proxyList.map((proxy) => this.fresh(proxy))
      await Promise.all([
        writeRelays(this.storage, this.relayList),
        writeProxies(this.storage, this.proxyList),
      ])
    }
    // An active exit that is gone would leave the menu without one to test or
    // update, so the first exit takes its place. With no exit at all, there is
    // nothing to choose.
    const active = this.rules.activeExitId
    const kept = active !== undefined && this.exit(active) !== undefined
    if (!kept && this.exits().length > 0) {
      this.rules = { ...this.rules, activeExitId: this.exits()[0]?.id }
    }
  }

  /** A record whose used-up latch is cleared when its reset has passed. */
  private fresh<T extends ExitRecord>(exit: T): T {
    if (exit.status !== "exhausted") return exit
    if ((exit.exhaustedUntil ?? 0) > Date.now()) return exit
    const { exhaustedUntil: _until, ...rest } = exit
    return { ...rest, status: "reachable" as Status } as T
  }

  /** The stored accounts. */
  accounts(): readonly Account[] {
    return this.accountList
  }

  /** The stored relays. */
  relays(): readonly RelayRecord[] {
    return this.relayList
  }

  /** The stored proxies. */
  proxies(): readonly ProxyRecord[] {
    return this.proxyList
  }

  /** Every exit, relays first, in the order the strategies use them. */
  exits(): readonly ExitRecord[] {
    return [...this.relayList, ...this.proxyList]
  }

  /** The routing rules as they stand. */
  settings(): Settings {
    return this.rules
  }

  /** The account with this id, if it is still there. */
  account(id: string): Account | undefined {
    return this.accountList.find((account) => account.id === id)
  }

  /** Any exit with this id, whichever kind it is. */
  exit(id: string): ExitRecord | undefined {
    return this.relayList.find((relay) => relay.id === id) ?? this.proxyList.find((proxy) => proxy.id === id)
  }

  /** The relay with this id, if it is still there. */
  relay(id: string): RelayRecord | undefined {
    return this.relayList.find((relay) => relay.id === id)
  }

  /** The proxy with this id, if it is still there. */
  proxy(id: string): ProxyRecord | undefined {
    return this.proxyList.find((proxy) => proxy.id === id)
  }

  /** The exit the strategies prefer, when one is picked and still exists. */
  activeExit(): ExitRecord | undefined {
    const id = this.rules.activeExitId
    return id === undefined ? undefined : this.exit(id)
  }

  /** The exit traffic goes through, when one is picked and still exists. */
  activeRelay(): RelayRecord | undefined {
    const active = this.activeExit()
    return active?.kind === "relay" ? active : undefined
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
    // A plugin with one exit and no choice would report "no exit" while an exit
    // sits right there, so the first one becomes the chosen one.
    if (this.rules.activeExitId === undefined) {
      this.rules = { ...this.rules, activeExitId: relay.id }
      await writeSettings(this.storage, this.rules)
    }
    return relay
  }

  /** Store a proxy. */
  async addProxy(proxy: ProxyRecord): Promise<ProxyRecord> {
    this.proxyList = [...this.proxyList, proxy]
    await writeProxies(this.storage, this.proxyList)
    if (this.rules.activeExitId === undefined) {
      this.rules = { ...this.rules, activeExitId: proxy.id }
      await writeSettings(this.storage, this.rules)
    }
    return proxy
  }

  /** Store many proxies with one write, so a long list is not a long disk wait. */
  async addProxyList(proxies: readonly ProxyRecord[]): Promise<void> {
    if (proxies.length === 0) return
    this.proxyList = [...this.proxyList, ...proxies]
    await writeProxies(this.storage, this.proxyList)
    if (this.rules.activeExitId === undefined) {
      const first = this.exits()[0]
      if (first) {
        this.rules = { ...this.rules, activeExitId: first.id }
        await writeSettings(this.storage, this.rules)
      }
    }
  }

  /** Change the parts of a proxy the user can edit. A new URL is a new exit. */
  async updateProxy(
    id: string,
    input: { readonly name?: string; readonly url?: string },
  ): Promise<ProxyRecord | undefined> {
    const current = this.proxy(id)
    if (!current) return undefined
    const urlChanged = input.url !== undefined && input.url !== current.url
    // A new address is a new exit: the old reset time belongs to a machine that
    // is no longer behind this entry.
    const { exhaustedUntil: _until, ...reset } = current
    const next: ProxyRecord = {
      ...(urlChanged ? reset : current),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(urlChanged ? { status: "untested" as Status, enabled: true } : {}),
    }
    this.proxyList = this.proxyList.map((proxy) => (proxy.id === id ? next : proxy))
    this.cooling.delete(id)
    this.stats.delete(id)
    await writeProxies(this.storage, this.proxyList)
    return next
  }

  /** Record what a check or a request found. Says whether anything changed. */
  async setHealth(id: string, update: HealthUpdate): Promise<boolean> {
    const current = this.exit(id)
    if (!current) return false
    const checkedAt = update.checkedAt ?? Date.now()
    // A stale reset time would keep a record looking used up after a test
    // proved it works again, so it only travels with an exhausted status.
    const { exhaustedUntil: previousUntil, ...rest } = current
    const until = update.exhaustedUntil ?? previousUntil
    const next: ExitRecord = {
      ...rest,
      status: update.status,
      lastCheck: checkedAt,
      ...(update.latencyMs !== undefined ? { latencyMs: update.latencyMs } : {}),
      ...(update.egress !== undefined ? { egress: update.egress } : {}),
      ...(update.runtime !== undefined ? { runtime: update.runtime } : {}),
      ...(update.lastError !== undefined ? { lastError: update.lastError } : {}),
      ...(update.status === "exhausted" && until !== undefined ? { exhaustedUntil: until } : {}),
    }
    if (update.status === "ready" || update.status === "reachable") {
      this.cooling.delete(id)
    }
    await this.replaceExit(next)
    return (
      current.status !== next.status ||
      current.lastError !== next.lastError ||
      current.exhaustedUntil !== next.exhaustedUntil
    )
  }

  /** Record whether the relay answered its last check. Kept for older callers. */
  async setRelayStatus(id: string, status: RelayRecord["status"]): Promise<boolean> {
    return this.setHealth(id, { status })
  }

  /** Pause an exit, or bring it back. A paused exit is kept and never used. */
  async setExitEnabled(id: string, enabled: boolean): Promise<boolean> {
    const current = this.exit(id)
    if (!current) return false
    const next: ExitRecord = { ...current, enabled }
    if (!enabled) this.cooling.delete(id)
    await this.replaceExit(next)
    return true
  }

  /**
   * A rate limit that is not the free allowance.
   *
   * The exit keeps working, but not for the next minute: hammering a server
   * that just asked for a pause is how a short limit becomes a long one.
   */
  markRateLimited(id: string, until: number, note?: string): void {
    const exit = this.exit(id)
    if (!exit) return
    this.cooling.set(id, { until, failures: this.cooling.get(id)?.failures ?? 0 })
    const next: ExitRecord = {
      ...exit,
      status: "limited",
      ...(note !== undefined ? { lastError: note.slice(0, 240) } : {}),
    }
    void this.replaceExit(next).catch(() => {})
  }

  /** An exit OpenCode refuses to talk to, e.g. a blocked address. */
  markBlocked(id: string, note?: string): void {
    const exit = this.exit(id)
    if (!exit) return
    const next: ExitRecord = {
      ...exit,
      status: "blocked",
      ...(note !== undefined ? { lastError: note.slice(0, 240) } : {}),
    }
    void this.replaceExit(next).catch(() => {})
  }

  /** One exit as the terminal UI sees it. */
  summaryOf(id: string): ExitSummary | undefined {
    const exit = this.exit(id)
    return exit === undefined ? undefined : toExitSummary(exit, this.statsFor(id))
  }

  /** Replace one exit in memory and on disk. */
  private async replaceExit(next: ExitRecord): Promise<void> {
    if (next.kind === "relay") {
      this.relayList = this.relayList.map((relay) => (relay.id === next.id ? next : relay))
      await writeRelays(this.storage, this.relayList)
    } else {
      this.proxyList = this.proxyList.map((proxy) => (proxy.id === next.id ? next : proxy))
      await writeProxies(this.storage, this.proxyList)
    }
  }

  /** Forget an exit, and stop routing through it when it was the active one. */
  async removeExit(id: string): Promise<ExitRecord | undefined> {
    const exit = this.exit(id)
    if (!exit) return undefined
    if (exit.kind === "relay") {
      this.relayList = this.relayList.filter((relay) => relay.id !== id)
      await writeRelays(this.storage, this.relayList)
    } else {
      this.proxyList = this.proxyList.filter((proxy) => proxy.id !== id)
      await writeProxies(this.storage, this.proxyList)
    }
    this.cooling.delete(id)
    this.stats.delete(id)
    for (const [key, entry] of this.relayed) {
      if (entry.exitId === id) this.relayed.delete(key)
    }
    if (this.rules.activeExitId === id) {
      // The next exit takes the place of the one that is gone, so the menu and
      // the footer still have an exit to name and to test.
      this.rules = { ...this.rules, activeExitId: this.exits()[0]?.id }
      await writeSettings(this.storage, this.rules)
    }
    return exit
  }

  /** Forget a relay. */
  async removeRelay(id: string): Promise<RelayRecord | undefined> {
    const relay = this.relay(id)
    if (!relay) return undefined
    await this.removeExit(id)
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

  /** Pick the exit traffic prefers, or none at all. */
  async setActiveExit(id: string | undefined): Promise<void> {
    this.rules = { ...this.rules, activeExitId: id }
    // In round robin, choosing an exit means starting the rotation there.
    const index = id === undefined ? -1 : this.exits().findIndex((exit) => exit.id === id)
    if (this.rules.strategy === "round-robin" && index >= 0) this.cursor = index
    await writeSettings(this.storage, this.rules)
  }

  /** How requests that cannot use an exit behave. */
  async setDirect(direct: DirectPolicy): Promise<void> {
    this.rules = { ...this.rules, direct }
    await writeSettings(this.storage, this.rules)
  }

  /** Whether the server checks exits in the background. */
  async setHealthChecks(healthChecks: boolean): Promise<void> {
    this.rules = { ...this.rules, healthChecks }
    await writeSettings(this.storage, this.rules)
  }

  /** Choose how the exits are used. */
  async setStrategy(strategy: Strategy): Promise<void> {
    this.rules = { ...this.rules, strategy }
    // Round robin starts at the exit the user chose, so switching to it does
    // not silently move the first request somewhere else.
    const index =
      this.rules.activeExitId === undefined
        ? -1
        : this.exits().findIndex((exit) => exit.id === this.rules.activeExitId)
    this.cursor = strategy === "round-robin" && index >= 0 ? index : 0
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
    this.notes_ = [...this.notes_, message].slice(-20)
  }

  /** The things the user should be told about, newest last. */
  notes(): readonly string[] {
    return this.notes_
  }

  /** Why an address was marked as spent, when the provider said. */
  noteSpendReason(egress: string, body: string): void {
    this.spendReasons.set(egress, body.replace(/\s+/g, " ").slice(0, 200))
    while (this.spendReasons.size > 64) {
      const first = this.spendReasons.keys().next().value
      if (first === undefined) break
      this.spendReasons.delete(first)
    }
  }

  /** Why an address was marked as spent, when the provider said. */
  spendReason(egress: string): string | undefined {
    return this.spendReasons.get(egress)
  }

  /** Whether an exit may serve a request now. */
  private usable(exit: ExitRecord, now: number): boolean {
    if (!exit.enabled) return false
    if (exit.status === "exhausted" && (exit.exhaustedUntil ?? 0) > now) return false
    if (exit.status === "untested") return false
    if (exit.status === "unreachable" || exit.status === "blocked" || exit.status === "bad") return false
    const cool = this.cooling.get(exit.id)
    if (cool !== undefined && cool.until > now) return false
    return true
  }

  /** Why an exit is not usable, in words the menu can show. */
  private skipReason(exit: ExitRecord, now: number): string {
    if (!exit.enabled) return "paused"
    if (exit.status === "exhausted") {
      return exit.exhaustedUntil !== undefined && exit.exhaustedUntil > now
        ? `used up until ${resetTime(exit.exhaustedUntil)}`
        : "used up"
    }
    if (exit.status === "untested") return "not tested yet"
    if (exit.status === "unreachable") return "not answering"
    if (exit.status === "blocked") return "blocked by OpenCode"
    if (exit.status === "bad") return "failing"
    if (exit.status === "limited") return "rate limited"
    const cool = this.cooling.get(exit.id)
    if (cool !== undefined && cool.until > now) return `cooling until ${resetTime(cool.until)}`
    return "not available"
  }

  /**
   * The exit that serves the next request.
   *
   * The strategy decides: one exit preferred, one request each in turn, one
   * until it is used up, or the fastest measured one. An exit that is known not
   * to answer, is paused, or is cooling never serves a request; the caller
   * decides what happens then (direct, or a clear failure).
   */
  pickExit(options: { readonly advance?: boolean } = {}): PickResult {
    const advance = options.advance ?? true
    const now = Date.now()
    const all = this.exits()
    const usable: ExitRecord[] = []
    const skipped: SkippedExit[] = []
    for (const exit of all) {
      if (this.usable(exit, now)) usable.push(exit)
      else {
        skipped.push({
          id: exit.id,
          name: exit.name,
          kind: exit.kind,
          reason: this.skipReason(exit, now),
        })
      }
    }
    const { exit, cursor } = nextExit(usable, all, {
      strategy: this.rules.strategy,
      ...(this.rules.activeExitId !== undefined ? { activeId: this.rules.activeExitId } : {}),
      cursor: this.cursor,
    })
    if (advance) this.cursor = cursor
    if (exit === undefined) {
      const used = skipped.filter((entry) => entry.reason.startsWith("used up")).length
      const reason =
        all.length === 0
          ? "There is no relay or proxy yet."
          : used === all.length
            ? "Every exit is used up."
            : "No exit can serve a request right now."
      return { skipped, reason }
    }
    if (
      advance &&
      this.rules.strategy === "exhausted" &&
      exit.id !== this.rules.activeExitId
    ) {
      // The chosen exit ran out; the state remembers the next one so the
      // fallback is not recomputed from a shrinking list on every request.
      this.rules = { ...this.rules, activeExitId: exit.id }
      void writeSettings(this.storage, this.rules).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        this.noteFailure(`The next exit could not be remembered: ${message}`)
      })
    }
    return { exit, skipped, reason: "" }
  }

  /**
   * Remember that an exit did not answer.
   *
   * The wait starts at two minutes and doubles with every consecutive failure,
   * capped at thirty minutes; one success clears it. A single dropped
   * connection should not sideline an exit for the session, and an exit that
   * keeps failing should not be tried on every request.
   */
  markFailure(id: string, note?: string, status: ExitStatus = "unreachable"): void {
    const previous = this.cooling.get(id)?.failures ?? 0
    const failures = previous + 1
    const wait = Math.min(COOLDOWN_BASE_MS * 2 ** (failures - 1), COOLDOWN_MAX_MS)
    this.cooling.set(id, { until: Date.now() + wait, failures })
    const exit = this.exit(id)
    if (exit) {
      const next: ExitRecord = {
        ...exit,
        status,
        ...(note !== undefined ? { lastError: note.slice(0, 240) } : {}),
      }
      void this.replaceExit(next).catch(() => {})
    }
  }

  /** How long this exit has been failing, for a note. */
  failureCount(id: string): number {
    return this.cooling.get(id)?.failures ?? 0
  }

  /** The exits being skipped because they did not answer. */
  coolingExits(now = Date.now()): readonly string[] {
    return [...this.cooling]
      .filter(([id, entry]) => entry.until > now && this.exit(id) !== undefined)
      .map(([id]) => id)
  }

  /**
   * Remember the address an answer came from.
   *
   * This happens on every answer, so it stays in memory: a restart can afford
   * to learn the address again with the next request or check.
   */
  noteEgress(id: string, egress?: string, runtime?: string): void {
    if (egress === undefined && runtime === undefined) return
    const exit = this.exit(id)
    if (!exit) return
    const next: ExitRecord = {
      ...exit,
      ...(egress !== undefined ? { egress } : {}),
      ...(runtime !== undefined ? { runtime } : {}),
    }
    if (next.kind === "relay") {
      this.relayList = this.relayList.map((relay) => (relay.id === id ? next : relay))
    } else {
      this.proxyList = this.proxyList.map((proxy) => (proxy.id === id ? next : proxy))
    }
  }

  /** A request was sent through this exit. */
  noteRequest(id: string): void {
    const stats = this.stats.get(id) ?? EMPTY_STATS
    this.stats.set(id, { ...stats, requests: stats.requests + 1 })
  }

  /** An answer carried the request. */
  markSuccess(id: string, ms?: number): void {
    const stats = this.stats.get(id) ?? EMPTY_STATS
    const measured = ms !== undefined && Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : undefined
    const average =
      measured === undefined
        ? stats.averageMs
        : stats.averageMs === undefined
          ? measured
          : Math.round(stats.averageMs * 0.7 + measured * 0.3)
    this.stats.set(id, {
      ...stats,
      ok: stats.ok + 1,
      ...(measured !== undefined ? { lastMs: measured } : {}),
      ...(average !== undefined ? { averageMs: average } : {}),
    })
    this.cooling.delete(id)
    const exit = this.exit(id)
    if (!exit) return
    // The in-memory record is what the menu and the fastest strategy read. A
    // write per successful request would be a lot of disk traffic for a field
    // that a restart can afford to find slightly stale.
    const next: ExitRecord = {
      ...exit,
      status: "ready",
      lastCheck: Date.now(),
      ...(measured !== undefined ? { latencyMs: measured } : {}),
      ...(exit.exhaustedUntil !== undefined ? { exhaustedUntil: undefined } : {}),
    }
    if (next.kind === "relay") {
      this.relayList = this.relayList.map((relay) => (relay.id === id ? next : relay))
    } else {
      this.proxyList = this.proxyList.map((proxy) => (proxy.id === id ? next : proxy))
    }
  }

  /** A relay asked for another instance. */
  markRotated(id: string): void {
    const stats = this.stats.get(id) ?? EMPTY_STATS
    this.stats.set(id, { ...stats, rotated: stats.rotated + 1 })
  }

  /** A 429 was seen. */
  markLimited(id: string): void {
    const stats = this.stats.get(id) ?? EMPTY_STATS
    this.stats.set(id, { ...stats, limited: stats.limited + 1 })
  }

  /** A transport failure or a server error was seen. */
  markFailed(id: string): void {
    const stats = this.stats.get(id) ?? EMPTY_STATS
    this.stats.set(id, { ...stats, failed: stats.failed + 1 })
  }

  /** What this exit has done since the process started. */
  statsFor(id: string): ExitStats {
    return this.stats.get(id) ?? EMPTY_STATS
  }

  /**
   * A relay whose allowance is gone.
   *
   * With the strategy that uses an exit until it is exhausted, the preference
   * moves on to the next *usable* exit here. The used-up exit stays in the
   * list, with a reset time, so it comes back on its own.
   */
  markExhausted(id: string, until: number, note?: string): void {
    const exit = this.exit(id)
    if (!exit) return
    const next: ExitRecord = {
      ...exit,
      status: "exhausted",
      exhaustedUntil: until,
      ...(note !== undefined ? { lastError: note.slice(0, 240) } : {}),
    }
    if (next.kind === "relay") {
      this.relayList = this.relayList.map((relay) => (relay.id === id ? next : relay))
    } else {
      this.proxyList = this.proxyList.map((proxy) => (proxy.id === id ? next : proxy))
    }
    void (next.kind === "relay"
      ? writeRelays(this.storage, this.relayList)
      : writeProxies(this.storage, this.proxyList)
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      this.noteFailure(`The used-up exit could not be remembered: ${message}`)
    })
    if (this.rules.strategy !== "exhausted") return
    if (this.rules.activeExitId !== id) return
    const pick = this.pickExit({ advance: false })
    if (!pick.exit) return
    this.rules = { ...this.rules, activeExitId: pick.exit.id }
    void writeSettings(this.storage, this.rules).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      this.noteFailure(`The next exit could not be remembered: ${message}`)
    })
  }

  /** The exits whose allowance is gone and whose reset has not passed. */
  exhaustedExits(now = Date.now()): readonly string[] {
    const exhausted: string[] = []
    const expired: ExitRecord[] = []
    for (const exit of this.exits()) {
      if (exit.status !== "exhausted") continue
      if ((exit.exhaustedUntil ?? 0) > now) exhausted.push(exit.id)
      else expired.push(exit)
    }
    if (expired.length > 0) {
      // The reset has passed: the exit is worth trying again. It is not called
      // ready until something answers through it.
      for (const exit of expired) {
        const { exhaustedUntil: _until, ...rest } = exit
        const next: ExitRecord = { ...rest, status: "reachable" }
        if (next.kind === "relay") {
          this.relayList = this.relayList.map((relay) => (relay.id === exit.id ? next : relay))
        } else {
          this.proxyList = this.proxyList.map((proxy) => (proxy.id === exit.id ? next : proxy))
        }
      }
      void Promise.all([
        writeRelays(this.storage, this.relayList),
        writeProxies(this.storage, this.proxyList),
      ]).catch(() => {})
    }
    return exhausted
  }

  /**
   * Bring the used-up exits back into use now.
   *
   * The addresses that were marked as spent are left alone: they are a fact
   * about the address, not about the relay, and a relay that comes back can
   * still be asked to recycle to another one.
   */
  async restoreExhausted(): Promise<string[]> {
    const restored: string[] = []
    this.relayList = this.relayList.map((relay) => {
      if (relay.status !== "exhausted") return relay
      restored.push(relay.id)
      this.cooling.delete(relay.id)
      const { exhaustedUntil: _until, ...rest } = relay
      return { ...rest, status: "reachable" as Status }
    })
    this.proxyList = this.proxyList.map((proxy) => {
      if (proxy.status !== "exhausted") return proxy
      restored.push(proxy.id)
      this.cooling.delete(proxy.id)
      const { exhaustedUntil: _until, ...rest } = proxy
      return { ...rest, status: "reachable" as Status }
    })
    this.cursor = 0
    if (restored.length > 0) {
      await Promise.all([
        writeRelays(this.storage, this.relayList),
        writeProxies(this.storage, this.proxyList),
      ])
    }
    return restored
  }

  /** Remember an address whose free allowance is gone, so exits avoid it. */
  markSpent(egress: string, until: number): void {
    this.spent.set(egress, until)
    while (this.spent.size > 64) {
      const first = this.spent.keys().next().value
      if (first === undefined) break
      this.spent.delete(first)
    }
  }

  /** The addresses the exits should not send from, with expired entries dropped. */
  spentEgresses(now = Date.now()): string[] {
    for (const [egress, until] of this.spent) {
      if (until <= now) this.spent.delete(egress)
    }
    return [...this.spent.keys()]
  }

  /** Whether an egress address is known to be used up. */
  isSpent(egress: string, now = Date.now()): boolean {
    const until = this.spent.get(egress)
    return until !== undefined && until > now
  }

  /**
   * Remember that a request for this session and model went through an exit.
   *
   * The retry hook is not told which request failed, so the request hook leaves
   * this note and the retry hook reads it. Entries are short lived: a retry
   * happens within seconds, and anything older is not this failure.
   */
  noteRelayed(sessionID: string, modelID: string, exitId: string): void {
    const now = Date.now()
    if (this.relayed.size > 200) {
      for (const [key, entry] of this.relayed) {
        if (now - entry.at > 60_000) this.relayed.delete(key)
      }
    }
    this.relayed.set(`${sessionID}\u0000${modelID}`, { at: now, exitId })
  }

  /** A request that did not go through an exit must not inherit the last one's blame. */
  forgetRelayed(sessionID: string, modelID: string): void {
    this.relayed.delete(`${sessionID}\u0000${modelID}`)
    this.failures.delete(`${sessionID}\u0000${modelID}`)
    this.started.delete(`${sessionID}\u0000${modelID}`)
  }

  /** Which exit served this session and model a moment ago, if one did. */
  relayedBy(sessionID: string, modelID: string): string | undefined {
    const entry = this.relayed.get(`${sessionID}\u0000${modelID}`)
    if (entry === undefined || Date.now() - entry.at > 60_000) return undefined
    return entry.exitId
  }

  /** Whether a request for this session and model recently went through an exit. */
  wasRelayed(sessionID: string, modelID: string): boolean {
    return this.relayedBy(sessionID, modelID) !== undefined
  }

  /** The moment a routed request started, so its answer can be timed. */
  noteStarted(sessionID: string, modelID: string): void {
    this.started.set(`${sessionID}\u0000${modelID}`, Date.now())
  }

  /** How long the routed request took, when the answer arrived. */
  finishTiming(sessionID: string, modelID: string): number | undefined {
    const key = `${sessionID}\u0000${modelID}`
    const started = this.started.get(key)
    this.started.delete(key)
    return started === undefined ? undefined : Date.now() - started
  }

  /** What the last answer for this session and model said, for the retry hook. */
  noteFailureContext(sessionID: string, modelID: string, context: FailureContext): void {
    if (this.failures.size > 200) {
      const now = Date.now()
      for (const [key, entry] of this.failures) {
        if (now - entry.at > 60_000) this.failures.delete(key)
      }
    }
    this.failures.set(`${sessionID}\u0000${modelID}`, context)
  }

  /** The failure the retry hook is about, when it belongs to a routed request. */
  failureFor(sessionID: string, modelID: string): FailureContext | undefined {
    const entry = this.failures.get(`${sessionID}\u0000${modelID}`)
    if (entry === undefined) return undefined
    if (Date.now() - entry.at > 60_000) {
      this.failures.delete(`${sessionID}\u0000${modelID}`)
      return undefined
    }
    return entry
  }

  /** A real request, kept so a test can look like OpenCode Free. */
  noteSample(sample: Omit<RequestSample, "at">): void {
    this.sample = { ...sample, at: Date.now() }
  }

  /** The last real request, when it is recent enough to be representative. */
  requestSample(maxAgeMs = 30 * 60_000): RequestSample | undefined {
    if (this.sample === undefined) return undefined
    if (Date.now() - this.sample.at > maxAgeMs) return undefined
    return this.sample
  }

  /** What the last routing decision was. */
  noteDecision(decision: Omit<LastDecision, "at">): void {
    this.lastDecision_ = { ...decision, at: Date.now() }
  }

  /** The last routing decision, for the preview page. */
  lastDecision(): LastDecision | undefined {
    return this.lastDecision_
  }

  /** A background scan started or progressed. */
  setScanning(progress: ScanProgress | undefined): void {
    this.scanning_ = progress
  }

  /** A background scan in progress, if any. */
  scanning(): ScanProgress | undefined {
    return this.scanning_
  }

  /** Whether another attempt after a used-up answer can reach an exit that still works. */
  canRetryAfterAllowance(): boolean {
    return this.pickExit({ advance: false }).exit !== undefined
  }

  /** Every exit as the terminal UI sees it. */
  summaries(): ExitSummary[] {
    return this.exits().map((exit) => toExitSummary(exit, this.statsFor(exit.id)))
  }
}
