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
  exitReportedText,
  resetTime,
  type ExitStatus as Status,
  type ExitSummary,
  toExitSummary,
} from "../lib/types.ts"
import { nextExit } from "../lib/routing.ts"
import {
  ACCOUNTS_KEY,
  PROXIES_KEY,
  RELAYS_KEY,
  SETTINGS_KEY,
  readAccounts,
  readProxies,
  readRelays,
  readSettings,
  writeAccounts,
  writeProxies,
  writeRelays,
  writeSettings,
} from "./storage.ts"

/**
 * Put back the fields one change set, where nothing else has touched them.
 *
 * A rollback that restored the whole object would throw away whatever
 * another writer did while the write was in flight. Only the fields this
 * call set are taken back, and only where they still hold what this call
 * put there.
 */
function restoreFields(previous: Settings, changed: Settings, current: Settings): Settings {
  const restored: Record<string, unknown> = { ...current }
  const before = previous as unknown as Record<string, unknown>
  const after = changed as unknown as Record<string, unknown>
  const now = current as unknown as Record<string, unknown>
  for (const key of Object.keys(after)) {
    if (now[key] !== after[key]) continue
    restored[key] = before[key]
  }
  return restored as unknown as Settings
}

/**
 * The kind of request a note belongs to when the caller does not say.
 *
 * OpenCode sends a session's title request beside its agent loop, with the
 * same model and the same session. The two must not take each other's notes,
 * so the kind is part of the key of every attribution entry.
 */
const PRIMARY_KIND = "primary"

/** The key an attribution entry is stored under. */
function attributionKey(sessionID: string, modelID: string, kind: string): string {
  return `${sessionID}\u0000${modelID}\u0000${kind}`
}

/** The prefix every kind of one session's requests shares. */
function attributionPrefix(sessionID: string, modelID: string): string {
  return `${sessionID}\u0000${modelID}\u0000`
}

/** Whether two exit records hold exactly the same fields. */
function sameExitRecord(left: ExitRecord, right: ExitRecord): boolean {
  const a = left as unknown as Record<string, unknown>
  const b = right as unknown as Record<string, unknown>
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[key] !== b[key]) return false
  }
  return true
}

/**
 * A write that did not land.
 *
 * The change is in memory but not on disk, so the caller has to be told: a
 * change that looks saved and is not would be lost at the next restart.
 */export class StorageError extends Error {
  constructor(
    /** The stored list that could not be written, e.g. "relays". */
    readonly key: string,
    readonly reason: unknown,
  ) {
    super(
      `The ${key} could not be written: ${reason instanceof Error ? reason.message : String(reason)}`,
    )
    this.name = "StorageError"
  }
}

/**
 * The proxies, with the reason they cannot serve.
 *
 * The local proxy bridge carries every proxy request, so a bridge that is
 * not running stops all of them: the picker has to leave them out, or it
 * would name an exit that cannot carry the request.
 */
export function proxyExclusions(state: RelayState): { readonly id: string; readonly reason: string }[] {
  return state
    .exits()
    // A paused proxy is out of use for its own reason, and the picker says
    // so first: naming the bridge here would hide the pause behind a
    // problem the user did not have.
    .filter((exit) => exit.kind === "proxy" && exit.enabled)
    .map((exit) => ({ id: exit.id, reason: "the local proxy bridge is not running" }))
}

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
  /**
   * Where the round-robin rotation stood.
   *
   * The exit that served last, so a restart carries on from there instead of
   * starting the rotation at the first exit every time.
   */
  readonly rotationId?: string
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

/**
 * How often the fastest strategy sends a request to another exit.
 *
 * The fastest exit is the only one that is picked, so the others would keep
 * the measurement they had when they were last tried. Every few requests one
 * goes to the least-measured exit instead, so it is measured again.
 */
const REMEASURE_EVERY = 5

/**
 * How often the rotation position is written.
 *
 * The position is written with the rules, so a restart carries on from where
 * it was. Writing it on every request would write a file per request, so it
 * is written at most this often: the position on disk is then at most a few
 * seconds old.
 */
const ROTATION_WRITE_MS = 5_000

/** The longest a failing exit is left alone. */
export const COOLDOWN_MAX_MS = 30 * 60_000

/** How long an unconfirmed refusal is left alone. */
export const REFUSED_COOLDOWN_MS = 15 * 60_000

/** How long a short rate limit is left alone. */
export const RATE_LIMIT_COOLDOWN_MS = 60_000

/**
 * How long a session and model are still blamed on the exit that served them.
 *
 * A retry normally follows its answer within seconds, but a slow request can
 * take minutes: the request hook clears the note at the start of every new
 * request, so a generous window cannot blame the wrong exit.
 */
const ATTRIBUTION_TTL_MS = 30 * 60_000

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
  /**
   * The epoch this check saw when it started.
   *
   * Every live verdict bumps the epoch, so a check that began before one is
   * stale even when its `checkedAt` looks newer than the record's last check.
   */
  readonly healthEpoch?: number
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
  /**
   * The exit the round-robin rotation served last.
   *
   * A place in the list cannot survive the list changing: an exit added or
   * removed shifts every place after it, so a number would point at the
   * wrong exit. The exit itself is remembered instead, and the rotation
   * carries on from wherever it now stands.
   */
  private lastServedId: string | undefined
  /** Where a round-robin rotation starts, when the user chose the exit. */
  private rotationStartId: string | undefined
  /** How many requests the fastest strategy has sent, for the re-measure. */
  private fastestTurns = 0
  /** When the rotation position was last written. */
  private lastRotationWrite = 0
  /** Why an address was marked as spent, when the provider said why. */
  private readonly spendReasons = new Map<string, string>()
  /** Exits that did not answer, and how many times in a row. */
  private readonly cooling = new Map<string, { until: number; failures: number }>()
  /** How many live verdicts each exit has taken, so a check in flight can tell it is stale. */
  private readonly epochs = new Map<string, number>()
  /** Requests and answers seen through each exit since the process started. */
  private readonly stats = new Map<string, ExitStats>()
  /** Requests that went through an exit, so a retry knows a failure came from one. */
  private readonly relayed = new Map<string, { readonly at: number; readonly exitId: string }>()
  /** When each routed request started, and the exit it went through. */
  private readonly started = new Map<string, { readonly at: number; readonly exitId: string }>()
  /** What the last answer said, so the retry hook does not have to guess. */
  private readonly failures = new Map<string, FailureContext>()
  /**
   * The requests that went direct instead of through an exit.
   *
   * The retry hook looks for the agent loop's exit and falls back to another
   * kind's note when the loop has none. A request that went direct has no
   * exit to blame, so the fallback must not reach for another kind's note.
   */
  private readonly direct = new Set<string>()
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
    // Whether a used-up latch has run out is decided on the stored records,
    // before they are freshened: a record that was freshened first would
    // never look expired, and the cleared state would never be written back.
    const expired = [...relays, ...proxies].some(
      (exit) => exit.status === "exhausted" && (exit.exhaustedUntil ?? 0) <= Date.now(),
    )
    this.relayList = relays.map((relay) => this.fresh(relay))
    this.proxyList = proxies.map((proxy) => this.fresh(proxy))
    this.rules = settings ?? { ...DEFAULT_SETTINGS, customModels: [] }
    // The rotation picks up where it was: a restart that always started at
    // the first exit would let that one burn its allowance first every time.
    // Where the position was never written, the exit the user chose is where
    // the rotation starts: choosing an exit means starting the rotation
    // there, and that choice outlives a restart too.
    if (this.rules.rotationId !== undefined) {
      this.lastServedId = this.rules.rotationId
    } else if (this.rules.activeExitId !== undefined) {
      this.rotationStartId = this.rules.activeExitId
    }
    // A live failure's rest was written with its status, so a restart picks it
    // back up: `usable()` needs the entry to see both that the exit failed
    // live and when the rest is over. An entry whose rest has already passed
    // is restored too — without it a recorded failure would look like a test
    // verdict, and only another test could clear it. A record without the
    // fields holds a test verdict only, and leaves the map alone.
    for (const exit of [...this.relayList, ...this.proxyList]) {
      if (exit.coolingUntil === undefined) continue
      this.cooling.set(exit.id, { until: exit.coolingUntil, failures: exit.failures ?? 0 })
    }
    if (expired) {
      // The cleared latch is written back: the disk would otherwise keep
      // saying "used up" until some unrelated write rewrote the list. A write
      // that fails is reported and not waited for: the latch is already
      // cleared in memory, and the plugin must still start.
      void Promise.all([
        this.enqueueWrite(RELAYS_KEY, () => writeRelays(this.storage, this.relayList)),
        this.enqueueWrite(PROXIES_KEY, () => writeProxies(this.storage, this.proxyList)),
      ]).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        this.noteFailure(`The used-up exits could not be cleared on disk: ${message}`)
      })
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

  /**
   * One write queue per storage key.
   *
   * Every durable write rewrites its whole key, so two overlapping writes
   * would land in completion order, not call order: a success after a
   * failure could be overwritten on disk by the failure that preceded it,
   * and a restart would then serve an exit that is really resting — or bench
   * one that just worked. Queueing per key makes the last mutation win, and
   * each queued write snapshots the list at run time, so it always persists
   * the latest memory.
   */
  private readonly writeQueues = new Map<string, Promise<void>>()

  private enqueueWrite(key: string, write: () => Promise<void>): Promise<void> {
    const tail = this.writeQueues.get(key) ?? Promise.resolve()
    // A write that fails must not be reported as a write that landed: the
    // change is in memory but not on disk, and the caller has to know.
    const next = tail.then(write).catch((reason: unknown) => {
      throw new StorageError(key, reason)
    })
    this.writeQueues.set(
      key,
      next.catch(() => {}),
    )
    return next
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
    try {
      await this.enqueueWrite(ACCOUNTS_KEY, () => writeAccounts(this.storage, this.accountList))
    } catch (error) {
      // The change did not land, so it must not stay in memory either: a
      // reader would see an account that is not stored.
      this.accountList = this.accountList.filter((item) => item.id !== account.id)
      throw error
    }
    return account
  }

  /** Forget an account. The relays it deployed stay: they run on their own. */
  async removeAccount(id: string): Promise<boolean> {
    const index = this.accountList.findIndex((account) => account.id === id)
    if (index < 0) return false
    const removed = this.accountList[index] as Account
    this.accountList = this.accountList.filter((account) => account.id !== id)
    try {
      await this.enqueueWrite(ACCOUNTS_KEY, () => writeAccounts(this.storage, this.accountList))
    } catch (error) {
      // The account was not forgotten, so it goes back where it was.
      this.accountList = [...this.accountList.slice(0, index), removed, ...this.accountList.slice(index)]
      throw error
    }
    return true
  }

  /** Store a relay. */
  async addRelay(relay: RelayRecord): Promise<RelayRecord> {
    this.relayList = [...this.relayList, relay]
    try {
      await this.enqueueWrite(RELAYS_KEY, () => writeRelays(this.storage, this.relayList))
    } catch (error) {
      this.relayList = this.relayList.filter((item) => item.id !== relay.id)
      throw error
    }
    // A plugin with one exit and no choice would report "no exit" while an exit
    // sits right there, so the first one becomes the chosen one. That pointer
    // is a second write, and it must not make the first one look lost: the
    // exit is stored either way, and a stale pointer is repaired at the next
    // load.
    if (this.rules.activeExitId === undefined) {
      await this.rememberChosenExit(relay.id)
    }
    return relay
  }

  /**
   * Point the routing at the first exit, without making the exit look lost.
   *
   * The pointer is written after the exit itself. A write that fails there
   * leaves the exit stored and the pointer stale, which the next load
   * repairs; it must not be reported as if the exit had never been stored.
   */
  private async rememberChosenExit(id: string): Promise<void> {
    try {
      await this.writeRules(() => ({ ...this.rules, activeExitId: id }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.noteFailure(`The chosen exit could not be remembered: ${message}`)
    }
  }

  /** Store a proxy. */
  async addProxy(proxy: ProxyRecord): Promise<ProxyRecord> {
    this.proxyList = [...this.proxyList, proxy]
    try {
      await this.enqueueWrite(PROXIES_KEY, () => writeProxies(this.storage, this.proxyList))
    } catch (error) {
      this.proxyList = this.proxyList.filter((item) => item.id !== proxy.id)
      throw error
    }
    if (this.rules.activeExitId === undefined) {
      await this.rememberChosenExit(proxy.id)
    }
    return proxy
  }

  /** Store many relays with one write, so an import is not a disk wait per entry. */
  async addRelayList(relays: readonly RelayRecord[]): Promise<void> {
    if (relays.length === 0) return
    const added = new Set(relays.map((relay) => relay.id))
    this.relayList = [...this.relayList, ...relays]
    try {
      await this.enqueueWrite(RELAYS_KEY, () => writeRelays(this.storage, this.relayList))
    } catch (error) {
      this.relayList = this.relayList.filter((item) => !added.has(item.id))
      throw error
    }
    if (this.rules.activeExitId === undefined) {
      const first = this.exits()[0]
      if (first) {
        await this.rememberChosenExit(first.id)
      }
    }
  }

  /** Store many proxies with one write, so a long list is not a long disk wait. */
  async addProxyList(proxies: readonly ProxyRecord[]): Promise<void> {
    if (proxies.length === 0) return
    const added = new Set(proxies.map((proxy) => proxy.id))
    this.proxyList = [...this.proxyList, ...proxies]
    try {
      await this.enqueueWrite(PROXIES_KEY, () => writeProxies(this.storage, this.proxyList))
    } catch (error) {
      this.proxyList = this.proxyList.filter((item) => !added.has(item.id))
      throw error
    }
    if (this.rules.activeExitId === undefined) {
      const first = this.exits()[0]
      if (first) {
        await this.rememberChosenExit(first.id)
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
    // The rest and the counters of the old address, so a failed write can
    // put them back: the record keeps `coolingUntil` beside a cleared map
    // would put the rest back on the next restart, and the counters would
    // vanish with it.
    const coolingBefore = this.cooling.get(id)
    const statsBefore = this.stats.get(id)
    let next: ProxyRecord
    if (urlChanged && input.url !== undefined) {
      // A new address is a new exit: the verdicts, measurements and resting
      // state the old record gathered belong to a machine that is no longer
      // behind this entry, so the record starts over untested. The memory
      // entries go with it — a record that kept `coolingUntil` beside a
      // cleared map would put the rest back on the next restart.
      next = {
        kind: "proxy",
        id,
        name: input.name ?? current.name,
        url: input.url,
        enabled: current.enabled,
        status: "untested" as Status,
        createdAt: current.createdAt,
      }
      this.cooling.delete(id)
      this.stats.delete(id)
      // Bump, never delete: a check that started before the URL changed
      // stamps the epoch it saw, and deleting the entry would make that old
      // stamp look current again — letting the old URL's verdict land on the
      // new record.
      this.bumpHealthEpoch(id)
    } else {
      // A rename is not a new exit: the same machine sits behind the entry,
      // so its verdicts, counters and any live rest all stay exactly as they
      // are. Only the fields the user touched move.
      next = {
        ...current,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.url !== undefined ? { url: input.url } : {}),
      }
    }
    this.proxyList = this.proxyList.map((proxy) => (proxy.id === id ? next : proxy))
    try {
      await this.enqueueWrite(PROXIES_KEY, () => writeProxies(this.storage, this.proxyList))
    } catch (error) {
      // The edit did not land, so it is taken back. A URL change is a new
      // exit: the old record goes back whole, with the rest and the counters
      // it carried, or the proxy would keep resting on a map entry that is
      // gone. A rename is not: only the fields this call set go back, and
      // only where the record still holds what this call wrote — a verdict
      // that landed while the write was in flight owns the record now.
      if (urlChanged) {
        this.proxyList = this.proxyList.map((proxy) => (proxy.id === id ? current : proxy))
        if (coolingBefore !== undefined) this.cooling.set(id, coolingBefore)
        if (statsBefore !== undefined) this.stats.set(id, statsBefore)
      } else {
        const live = this.proxy(id)
        if (live !== undefined) {
          // The name and the url go back only where the live record still
          // holds what this call wrote; a verdict that landed meanwhile is
          // left alone.
          const restored: { name?: string; url?: string } = {}
          if (input.name !== undefined && live.name === input.name) {
            restored.name = current.name
          }
          if (input.url !== undefined && live.url === input.url) {
            restored.url = current.url
          }
          if (restored.name !== undefined || restored.url !== undefined) {
            const next = { ...live, ...restored } as ProxyRecord
            this.proxyList = this.proxyList.map((proxy) =>
              proxy.id === id ? next : proxy,
            )
          }
        }
      }
      throw error
    }
    return next
  }

  /** Record what a check or a request found. Says whether anything changed. */
  async setHealth(id: string, update: HealthUpdate): Promise<boolean> {
    const current = this.exit(id)
    if (!current) return false
    // A verdict that proves nothing leaves the record alone. A check that
    // could not tell (no captured request, a refusal it cannot read) would
    // otherwise revive an exit that just failed a real request.
    if (update.status === "unknown") return false
    // A live verdict bumps the epoch, so a check that started before it is
    // stale however new its own `checkedAt` looks: applying its answer would
    // overwrite what a real request just proved. Callers that do not stamp an
    // epoch keep their old behavior.
    if (update.healthEpoch !== undefined && update.healthEpoch !== this.healthEpoch(id)) {
      return false
    }
    // Two checks can overlap and finish out of order. An answer stamped before
    // the one already on record is stale, and applying it could retire an exit
    // a newer check had just cleared. Callers that do not stamp a check keep
    // their old behavior.
    if (
      update.checkedAt !== undefined &&
      current.lastCheck !== undefined &&
      update.checkedAt < current.lastCheck
    ) {
      return false
    }
    const checkedAt = update.checkedAt ?? Date.now()
    // A stale reset time would keep a record looking used up after a test
    // proved it works again, so it only travels with an exhausted status. The
    // live rest is dropped with it for every verdict: a test verdict governs
    // alone, so a `bad` one still stays retired until another test, and a
    // restart must not resurrect a rest the test has just superseded. The old
    // failure note goes with the rest of the verdict: an update that carries
    // no error of its own replaces the whole verdict, and a "ready" record
    // that kept the previous error's text would show an error under a
    // healthy status.
    const {
      exhaustedUntil: previousUntil,
      coolingUntil: _cooling,
      failures: _failures,
      lastError: _previousError,
      ...rest
    } = current
    // The "used up" latch only ends when something proves the allowance is
    // back: a real model answer through this exit, which is what a "ready"
    // verdict means. The model list answers even when the allowance is gone,
    // so a check that only asked for it must not lift the latch - otherwise
    // every ten minutes the record would be cleared and the next request
    // would be sent to an address that has no allowance left.
    const usedUp = previousUntil !== undefined && previousUntil > checkedAt
    const stillUsedUp = usedUp && update.status !== "ready"
    const until = stillUsedUp ? previousUntil : update.exhaustedUntil ?? previousUntil
    // The runtime is the exit's own word about itself, and it is drawn on the
    // exit's page: it is stripped here, once, so no path can bring an escape
    // sequence to the screen.
    const runtime = exitReportedText(update.runtime)
    const next: ExitRecord = {
      ...rest,
      status: stillUsedUp ? "exhausted" : update.status,
      lastCheck: checkedAt,
      ...(update.latencyMs !== undefined ? { latencyMs: update.latencyMs } : {}),
      ...(update.egress !== undefined ? { egress: update.egress } : {}),
      ...(runtime !== undefined ? { runtime } : {}),
      ...(update.lastError !== undefined ? { lastError: update.lastError } : {}),
      ...(until !== undefined && (stillUsedUp || update.status === "exhausted")
        ? { exhaustedUntil: until }
        : {}),
    }
    // A verdict from a test or a probe supersedes whatever live rest was
    // armed: the record it writes carries no rest fields, and the in-memory
    // entry goes with it, for every status. A `bad` verdict then governs
    // alone — retired until another test — instead of reviving when an older
    // live rest happens to run out.
    const previousCooling = this.cooling.get(id)
    this.cooling.delete(id)
    try {
      await this.replaceExit(next)
    } catch (error) {
      // The verdict did not land, so the fields this call wrote go back.
      //
      // Only those fields, and only where the record still holds what this
      // call wrote: a live verdict that landed while the write was in flight
      // owns the record now, and putting the old one back over it would show
      // a request that just succeeded as failed. The epoch is never lowered
      // either: it only ever grows, and lowering it would let a check that
      // started before a live verdict overwrite that verdict.
      //
      // The rest goes back only with the record it was taken from, and only
      // when nothing armed a newer one: a live failure that landed during the
      // write has its own, longer rest, and the older one must not replace it.
      const restored = this.restoreVerdict(id, next, current)
      if (restored && previousCooling !== undefined && this.cooling.get(id) === undefined) {
        this.cooling.set(id, previousCooling)
      }
      throw error
    }
    return (
      current.status !== next.status ||
      current.lastError !== next.lastError ||
      current.exhaustedUntil !== next.exhaustedUntil
    )
  }

  /**
   * Put back the record a failed verdict wrote.
   *
   * A live verdict that landed while the write was in flight owns the record
   * now: putting the old one back over it would show a request that just
   * succeeded as failed, and move traffic off an exit that is working. The
   * old record goes back only where the record still holds exactly what this
   * call wrote, which is the case when nothing else touched it. Says whether
   * the record was put back.
   */
  private restoreVerdict(id: string, written: ExitRecord, before: ExitRecord): boolean {
    const current = this.exit(id)
    if (current === undefined) return false
    if (!sameExitRecord(current, written)) return false
    if (current.kind === "relay") {
      this.relayList = this.relayList.map((relay) =>
        relay.id === id ? (before as RelayRecord) : relay,
      )
    } else {
      this.proxyList = this.proxyList.map((proxy) =>
        proxy.id === id ? (before as ProxyRecord) : proxy,
      )
    }
    return true
  }

  /** How many live verdicts this exit has taken, for a check to stamp itself. */
  healthEpoch(id: string): number {
    return this.epochs.get(id) ?? 0
  }

  /** A live verdict makes every check already in flight out of date. */
  private bumpHealthEpoch(id: string): void {
    this.epochs.set(id, this.healthEpoch(id) + 1)
  }

  /** Pause an exit, or bring it back. A paused exit is kept and never used. */
  async setExitEnabled(id: string, enabled: boolean): Promise<boolean> {
    const current = this.exit(id)
    if (!current) return false
    // An exit that is already in the state asked for is left alone: nothing
    // changes, so nothing is written and nothing is announced.
    if (current.enabled === enabled) return false
    // Pausing is not a health verdict, so the rest is left alone: resuming,
    // here or after a restart, finds the exit still resting out its failure.
    const next: ExitRecord = { ...current, enabled }
    try {
      await this.replaceExit(next)
    } catch (error) {
      // The change did not land, so the switch goes back — and only the
      // switch. A live verdict that landed while the write was in flight
      // owns the rest of the record, and putting the old record back would
      // bench an exit that just worked (or lose the rest it just took). The
      // field goes back only where the record still holds what this call
      // wrote, so a second writer's change is never overwritten either.
      const live = this.exit(id)
      if (live !== undefined && live.enabled === enabled) {
        const restored: ExitRecord = { ...live, enabled: current.enabled }
        if (restored.kind === "relay") {
          this.relayList = this.relayList.map((relay) =>
            relay.id === id ? (restored as RelayRecord) : relay,
          )
        } else {
          this.proxyList = this.proxyList.map((proxy) =>
            proxy.id === id ? (restored as ProxyRecord) : proxy,
          )
        }
      }
      throw error
    }
    return true
  }

  /**
   * Bring every paused exit back into use.
   *
   * The exits are written once per kind rather than once per exit, so
   * resuming a list of ten costs two writes, not ten. The rests are left
   * alone: a paused exit that was resting keeps resting, and comes back
   * when its own rest is over.
   */
  async resumeAll(): Promise<string[]> {
    const resumed: string[] = []
    const relays = this.relayList.map((relay) => {
      if (relay.enabled) return relay
      resumed.push(relay.id)
      return { ...relay, enabled: true }
    })
    const proxies = this.proxyList.map((proxy) => {
      if (proxy.enabled) return proxy
      resumed.push(proxy.id)
      return { ...proxy, enabled: true }
    })
    if (resumed.length === 0) return resumed
    // Only the exits this call resumed go back when a write fails: a verdict
    // written meanwhile must not be discarded with them.
    const resumedRelays = new Set(
      resumed.filter((id) => this.relayList.some((relay) => relay.id === id)),
    )
    const resumedProxies = new Set(
      resumed.filter((id) => this.proxyList.some((proxy) => proxy.id === id)),
    )
    this.relayList = relays
    this.proxyList = proxies
    try {
      await this.enqueueWrite(RELAYS_KEY, () => writeRelays(this.storage, this.relayList))
    } catch (error) {
      // The relays were not written, so they go back to being paused. The
      // proxies were never written either, so they go back with them: they
      // were put in memory before the relays were written, and a proxy that
      // is enabled in memory but paused on disk serves traffic the next
      // restart takes away.
      this.relayList = this.relayList.map((relay) =>
        resumedRelays.has(relay.id) ? { ...relay, enabled: false } : relay,
      )
      this.proxyList = this.proxyList.map((proxy) =>
        resumedProxies.has(proxy.id) ? { ...proxy, enabled: false } : proxy,
      )
      throw error
    }
    try {
      await this.enqueueWrite(PROXIES_KEY, () => writeProxies(this.storage, this.proxyList))
    } catch (error) {
      // The proxies were not written, so they go back to being paused. The
      // relays were written, so they stay as they are: a rollback of both
      // would leave the disk saying something the memory does not.
      this.proxyList = this.proxyList.map((proxy) =>
        resumedProxies.has(proxy.id) ? { ...proxy, enabled: false } : proxy,
      )
      throw new StorageError(
        "proxies",
        `${error instanceof Error ? error.message : String(error)} The relays were resumed.`,
      )
    }
    return resumed
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
    this.bumpHealthEpoch(id)
    const failures = this.cooling.get(id)?.failures ?? 0
    // The rest is capped here, at the one choke point every caller goes
    // through: a Retry-After of years (a hostile or broken header) must not
    // be written into the persisted record, where only another test or a
    // success could ever clear it.
    const capped = Math.min(until, Date.now() + COOLDOWN_MAX_MS * 8)
    this.cooling.set(id, { until: capped, failures })
    // The rest is written with the status, so a restart keeps waiting it out
    // instead of serving before the cooldown has ended.
    const next: ExitRecord = {
      ...exit,
      status: this.failureStatus(exit, "limited"),
      coolingUntil: capped,
      failures,
      ...(note !== undefined ? { lastError: this.scrub(note).slice(0, 240) } : {}),
    }
    this.persistVerdict(next, "rate limit")
  }

  /** An exit OpenCode refuses to talk to, e.g. a blocked address. */
  markBlocked(id: string, note?: string): void {
    const exit = this.exit(id)
    if (!exit) return
    this.bumpHealthEpoch(id)
    // A refusal is a live failure like any other: rest the exit briefly instead
    // of retiring it, so the next request can prove the refusal has passed.
    const rested = this.rest(id)
    const next: ExitRecord = {
      ...exit,
      status: this.failureStatus(exit, "blocked"),
      coolingUntil: rested.until,
      failures: rested.failures,
      ...(note !== undefined ? { lastError: this.scrub(note).slice(0, 240) } : {}),
    }
    this.persistVerdict(next, "refusal")
  }

  /**
   * The status a failure verdict leaves behind.
   *
   * A live "used up" latch outranks a failure verdict: the address has no
   * allowance left, and that is the fact the user has to see. The rest the
   * failure arms still applies on top of it.
   */
  private failureStatus(exit: ExitRecord, status: ExitStatus): ExitStatus {
    if ((exit.exhaustedUntil ?? 0) > Date.now()) return "exhausted"
    return status
  }

  /** One exit as the terminal UI sees it. */
  summaryOf(id: string): ExitSummary | undefined {
    const exit = this.exit(id)
    if (exit === undefined) return undefined
    // The reason OpenCode gave for spending the address belongs next to the
    // reset time; without it "used up until X" is all the user ever sees.
    const egress = exit.egress
    const reason = egress !== undefined ? this.spendReason(egress) : undefined
    return toExitSummary(exit, this.statsFor(id), reason)
  }

  /** Replace one exit in memory and on disk, through its key's write queue. */
  private replaceExit(next: ExitRecord): Promise<void> {
    if (next.kind === "relay") {
      this.relayList = this.relayList.map((relay) => (relay.id === next.id ? next : relay))
      // The list is read when the write runs, so a change that was rolled
      // back in the meantime is not written back by this write.
      return this.enqueueWrite(RELAYS_KEY, () => writeRelays(this.storage, this.relayList))
    }
    this.proxyList = this.proxyList.map((proxy) => (proxy.id === next.id ? next : proxy))
    return this.enqueueWrite(PROXIES_KEY, () => writeProxies(this.storage, this.proxyList))
  }

  /** Forget an exit, and stop routing through it when it was the active one. */
  async removeExit(id: string): Promise<ExitRecord | undefined> {
    const exit = this.exit(id)
    if (!exit) return undefined
    // The exit goes back where it was if the write does not land, so memory
    // and disk agree on whether it is still there.
    const index = exit.kind === "relay"
      ? this.relayList.findIndex((relay) => relay.id === id)
      : this.proxyList.findIndex((proxy) => proxy.id === id)
    // The rotation stands where it was: when the exit that served last is
    // removed, the one before it takes its place, so the rotation carries on
    // with the next one instead of starting over.
    const lastServedBefore = this.lastServedId
    const cursorBefore = this.cursor
    if (this.lastServedId === id) {
      const before = this.exits()
      const at = before.findIndex((item) => item.id === id)
      const previous = at > 0 ? before[at - 1] : undefined
      this.lastServedId = previous?.id
      this.cursor = 0
    }
    if (exit.kind === "relay") {
      this.relayList = this.relayList.filter((relay) => relay.id !== id)
    } else {
      this.proxyList = this.proxyList.filter((proxy) => proxy.id !== id)
    }
    try {
      await this.enqueueWrite(
        exit.kind === "relay" ? RELAYS_KEY : PROXIES_KEY,
        () =>
          exit.kind === "relay"
            ? writeRelays(this.storage, this.relayList)
            : writeProxies(this.storage, this.proxyList),
      )
    } catch (error) {
      // The exit was not written, so it goes back. The rotation goes back
      // with it: a failed removal that moved the rotation would reorder it
      // for a removal that did not happen.
      if (exit.kind === "relay") {
        this.relayList = [...this.relayList.slice(0, index), exit as RelayRecord, ...this.relayList.slice(index)]
      } else {
        this.proxyList = [...this.proxyList.slice(0, index), exit as ProxyRecord, ...this.proxyList.slice(index)]
      }
      this.lastServedId = lastServedBefore
      this.cursor = cursorBefore
      throw error
    }
    // The cleanup comes before the settings write: the exit is gone either
    // way, and a rule that still names it is repaired at the next load.
    this.cooling.delete(id)
    this.epochs.delete(id)
    this.stats.delete(id)
    for (const [key, entry] of this.relayed) {
      if (entry.exitId === id) this.relayed.delete(key)
    }
    if (this.rules.activeExitId === id) {
      // The next exit takes the place of the one that is gone, so the menu and
      // the footer still have an exit to name and to test.
      const next = this.exits()[0]?.id
      try {
        await this.writeRules(() => ({ ...this.rules, activeExitId: next }))
      } catch (error) {
        // The removal itself landed, so the answer is not a failure: the
        // stale choice is fixed at the next load, and the user is told.
        this.noteFailure(
          `The chosen exit was reset in memory but could not be written: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
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
    await this.writeRules(() => ({ ...this.rules, enabled }))
  }

  /**
   * Put the rules in place, and take them back if the write did not land.
   *
   * A rule that could not be saved must not stay in memory: the menu would
   * show it as in force and the next restart would quietly undo it. Only the
   * change this call made is taken back, and only when nothing else has
   * changed the rules meanwhile.
   *
   * The whole read-modify-write runs in a chain, so two rule changes never
   * overlap: a change that was rolled back can never be written by a write
   * that was queued before the rollback, and the disk and the memory always
   * agree.
   */
  private async writeRules(build: (current: Settings) => Settings): Promise<void> {
    // The whole read-modify-write runs in the chain, so two rule changes
    // never overlap: the value is built when the write runs, after any
    // earlier write has rolled back, and a value that was rolled back can
    // never be written by a write that was queued behind it.
    const write = this.rulesChain.then(async () => {
      const previous = this.rules
      const next = build(this.rules)
      this.rules = next
      try {
        await this.enqueueWrite(SETTINGS_KEY, () => writeSettings(this.storage, next))
      } catch (error) {
        this.rules = restoreFields(previous, next, this.rules)
        throw error
      }
    })
    this.rulesChain = write.catch(() => {})
    return write
  }

  /** The rules write in flight, so two rule changes never overlap. */
  private rulesChain: Promise<void> = Promise.resolve()

  /** Choose which models are routed. Without a list, the custom one is kept as it is. */
  async setSelection(selection: Selection, models?: readonly string[]): Promise<Settings> {
    await this.writeRules((current) => ({
      ...current,
      selection,
      customModels: models === undefined ? [...current.customModels] : [...models],
    }))
    return this.rules
  }

  /** Pick the exit traffic prefers, or none at all. */
  async setActiveExit(id: string | undefined): Promise<void> {
    // In round robin, choosing an exit means starting the rotation there.
    const previousStart = this.rotationStartId
    const previousServed = this.lastServedId
    this.rotationStartId = id
    this.lastServedId = undefined
    // The stored position goes with it: a restart would otherwise resume the
    // rotation where it was. With no position on record, the load falls back
    // to the chosen exit, which is the start the user asked for.
    try {
      await this.writeRules(() => ({ ...this.rules, activeExitId: id, rotationId: undefined }))
    } catch (error) {
      // The choice did not land, so the rotation goes back to where it was.
      this.rotationStartId = previousStart
      this.lastServedId = previousServed
      throw error
    }
  }

  /** How requests that cannot use an exit behave. */
  async setDirect(direct: DirectPolicy): Promise<void> {
    await this.writeRules(() => ({ ...this.rules, direct }))
  }

  /** Whether the server checks exits in the background. */
  async setHealthChecks(healthChecks: boolean): Promise<void> {
    await this.writeRules(() => ({ ...this.rules, healthChecks }))
  }

  /** Choose how the exits are used. */
  async setStrategy(strategy: Strategy): Promise<void> {
    // Round robin starts at the exit the user chose, so switching to it does
    // not silently move the first request somewhere else.
    const previousStart = this.rotationStartId
    const previousServed = this.lastServedId
    const previousCursor = this.cursor
    this.rotationStartId = strategy === "round-robin" ? this.rules.activeExitId : undefined
    this.lastServedId = undefined
    this.cursor = 0
    // The stored position goes with it: a restart would otherwise resume the
    // rotation where it was. With no position on record, the load falls back
    // to the chosen exit, which is where the strategy starts.
    try {
      await this.writeRules(() => ({ ...this.rules, strategy, rotationId: undefined }))
    } catch (error) {
      // The change did not land, so the rotation goes back to where it was.
      this.rotationStartId = previousStart
      this.lastServedId = previousServed
      this.cursor = previousCursor
      throw error
    }
  }

  /**
   * Put several rules in place with one write.
   *
   * An import that wrote the rules one at a time could fail halfway and leave
   * a mixture of the old settings and the new ones.
   */
  async applySettings(update: Partial<Settings>): Promise<void> {
    // The rotation moves with the strategy, and goes back when the write
    // does not land, exactly as setStrategy's does.
    const previousStart = this.rotationStartId
    const previousServed = this.lastServedId
    const previousCursor = this.cursor
    if (update.strategy !== undefined) {
      // Round robin starts at the exit the user chose, so switching to it does
      // not silently move the first request somewhere else.
      this.rotationStartId = update.strategy === "round-robin" ? this.rules.activeExitId : undefined
      this.lastServedId = undefined
      this.cursor = 0
    }
    // The stored position goes with the strategy: a restart would otherwise
    // resume the rotation where it was.
    try {
      await this.writeRules(() => ({ ...this.rules, ...update, rotationId: undefined }))
    } catch (error) {
      this.rotationStartId = previousStart
      this.lastServedId = previousServed
      this.cursor = previousCursor
      throw error
    }
  }

  /**
   * Something the user should know about, shown in the status note.
   *
   * A failure that is only written to a log is a failure the user never learns
   * about, and a project left running because a deletion failed is worth
   * saying out loud.
   */
  noteFailure(message: string): void {
    // The note is drawn on the status page, so no control character in it
    // can draw one.
    const clean = message.replace(/[\u0000-\u001f\u007f-\u009f\u001b]/g, "")
    this.notes_ = [...this.notes_, clean].slice(-20)
  }

  /** The things the user should be told about, newest last. */
  notes(): readonly string[] {
    return this.notes_
  }

  /** Why an address was marked as spent, when the provider said. */
  noteSpendReason(egress: string, body: string): void {
    // The body came back through the exit, which controls it: it is drawn on
    // the exit's page, so an escape sequence in it must not survive.
    const cleaned = body.replace(/[\u0000-\u001f\u007f-\u009f\u001b]/g, " ")
    this.spendReasons.set(egress, this.scrub(cleaned.replace(/\s+/g, " ").slice(0, 200)))
    while (this.spendReasons.size > 64) {
      const first = this.spendReasons.keys().next().value
      if (first === undefined) break
      this.spendReasons.delete(first)
    }
  }

  /**
   * Take the captured credentials out of a text that came back through an exit.
   *
   * The body of a 429 travels through the exit, and a relay terminates the
   * connection: it could echo the request's own authorization header back.
   * The text is shown on the exit's page, so every captured value that is
   * long enough to be worth hiding is taken out of it.
   */
  private scrub(text: string): string {
    // The text is shown on the exit's page, so every captured value that is
    // long enough to be worth hiding is taken out of it, and no control
    // character survives: an exit that answers with an escape sequence would
    // otherwise draw one.
    const stripped = text.replace(/[\u0000-\u001f\u007f-\u009f\u001b]/g, "")
    const sample = this.requestSample()
    if (sample === undefined) return stripped
    let out = stripped
    for (const value of Object.values(sample.headers)) {
      if (value.length < 8) continue
      out = out.split(value).join("***")
    }
    return out
  }

  /** Why an address was marked as spent, when the provider said. */
  spendReason(egress: string): string | undefined {
    return this.spendReasons.get(egress)
  }

  /** Whether an exit may serve a request now. */
  private usable(exit: ExitRecord, now: number): boolean {
    if (!exit.enabled) return false
    // An imported exit nobody has tested stays out of service, whatever its
    // record says: a test that proved nothing must not leave the mark half
    // cleared, and a sweep that runs beside such a test must not promote the
    // address into live routing.
    if (exit.imported === true) return false
    // A live "used up" latch outranks every failure verdict: a transport
    // failure that lands after the exhaustion verdict would otherwise clear
    // the latch in all but name, and the exit would serve an address whose
    // allowance is gone once the short rest is over.
    if ((exit.exhaustedUntil ?? 0) > now) return false
    if (exit.status === "untested") return false
    const cool = this.cooling.get(exit.id)
    // A live failure rests the exit for a while, but it is not a retirement:
    // once the rest is over the exit is worth another try, and the next failure
    // arms a longer one. A failure with no rest on record came from a test, and
    // only another test may clear it.
    if (exit.status === "unreachable" || exit.status === "blocked" || exit.status === "bad") {
      return cool !== undefined && cool.until <= now
    }
    // A rate-limited exit is resting, not retired: it serves again once the
    // cooldown has passed, and never stays unusable just because its last
    // verdict was "limited".
    if (exit.status === "limited" && cool !== undefined && cool.until > now) return false
    if (cool !== undefined && cool.until > now) return false
    return true
  }

  /** Why an exit is not usable, in words the menu can show. */
  private skipReason(exit: ExitRecord, now: number): string {
    if (!exit.enabled) return "paused"
    // A live "used up" latch outranks every failure verdict, so the reason
    // says so too: the exit is not failing, its allowance is gone.
    if ((exit.exhaustedUntil ?? 0) > now) return `used up until ${resetTime(exit.exhaustedUntil ?? 0)}`
    if (exit.status === "exhausted") return "used up"
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
   *
   * `now` is for asking about another moment, as the other predicates here do.
   */
  pickExit(options: {
    readonly advance?: boolean
    readonly now?: number
    /** Exits to leave out, and why. */
    readonly exclude?: readonly { readonly id: string; readonly reason: string }[]
  } = {}): PickResult {
    const advance = options.advance ?? true
    const now = options.now ?? Date.now()
    const all = this.exits()
    const usable: ExitRecord[] = []
    const skipped: SkippedExit[] = []
    const excluded = new Map((options.exclude ?? []).map((entry) => [entry.id, entry.reason]))
    for (const exit of all) {
      // The exit's own reason comes first: an exit that is used up or paused
      // is out of use for that reason, and naming the exclusion instead would
      // hide it behind a problem the user did not have.
      if (!this.usable(exit, now)) {
        skipped.push({
          id: exit.id,
          name: exit.name,
          kind: exit.kind,
          reason: this.skipReason(exit, now),
        })
        continue
      }
      const reason = excluded.get(exit.id)
      if (reason !== undefined) {
        skipped.push({ id: exit.id, name: exit.name, kind: exit.kind, reason })
        continue
      }
      usable.push(exit)
    }
    /**
     * Where the round-robin rotation stands.
     *
     * The rotation walks the exits in order, so its position is remembered
     * as the place it reached in that order - not as a number into the
     * usable list, which changes as exits rest and come back. When the exit
     * that served last is resting, the rotation carries on to the next one
     * that can serve, so an exit that comes back is served in turn rather
     * than twice in a row.
     */
    const rotationStart = (): number => {
      const start = this.rotationStartId
      if (start !== undefined) {
        const index = usable.findIndex((candidate) => candidate.id === start)
        if (index >= 0) return index
        // The exit the user chose as the start cannot serve right now. The
        // rotation starts at the next one that can, and the chosen exit
        // keeps its place for when it comes back.
        const at = all.findIndex((candidate) => candidate.id === start)
        for (let step = 1; at >= 0 && step <= all.length; step++) {
          const candidate = all[(at + step) % all.length]
          if (candidate === undefined) continue
          const index = usable.findIndex((usableExit) => usableExit.id === candidate.id)
          if (index >= 0) return index
        }
      }
      const last = this.lastServedId
      if (last !== undefined) {
        // The exit that served last is looked up by id, not by the place it
        // had: an exit added or removed shifts every place after it, and a
        // number would then point at the wrong exit.
        const from = all.findIndex((candidate) => candidate.id === last)
        for (let step = 1; from >= 0 && step <= all.length; step++) {
          const candidate = all[(from + step) % all.length]
          if (candidate === undefined) continue
          const index = usable.findIndex((usableExit) => usableExit.id === candidate.id)
          if (index >= 0) return index
        }
      }
      return this.cursor
    }
    const { exit, cursor } = nextExit(
      usable.map((candidate) => this.withSpeed(candidate)),
      all.map((candidate) => this.withSpeed(candidate)),
      {
        strategy: this.rules.strategy,
        ...(this.rules.activeExitId !== undefined ? { activeId: this.rules.activeExitId } : {}),
        cursor: this.rules.strategy === "round-robin" ? rotationStart() : this.cursor,
      },
    )
    if (advance) this.cursor = cursor
    if (advance && this.rules.strategy === "round-robin" && exit !== undefined) {
      // The rotation remembers where it is by the exit it served, not by a
      // number that means different things as the list changes. A pick that
      // found nothing does not move the rotation: the exit the user chose as
      // its start is still the start when the exits come back.
      this.lastServedId = exit.id
      this.rotationStartId = undefined
      this.rememberRotation()
    }
    // The fastest strategy needs the other exits measured too: the fastest
    // exit is the only one that is ever picked, so an exit that was slow
    // once would be sidelined for the whole session and never get the chance
    // to prove the first measurement was a fluke. Every few turns one request
    // goes to the least-measured exit instead, and it is measured again.
    //
    // The turn is counted from the next request, so a preview that does not
    // advance anything still names the exit the next request would use.
    if (this.rules.strategy === "fastest" && usable.length > 1) {
      const turn = this.fastestTurns + 1
      const remeasure = turn % REMEASURE_EVERY === 0
      if (remeasure) {
        const least = usable.reduce<ExitRecord | undefined>((best, candidate) => {
          if (best === undefined) return candidate
          return this.statsFor(candidate.id).ok < this.statsFor(best.id).ok ? candidate : best
        }, undefined)
        if (least !== undefined && least.id !== exit?.id) {
          if (advance) {
            this.fastestTurns = turn
            this.lastServedId = least.id
          }
          return { exit: least, skipped, reason: "" }
        }
      }
      if (advance) this.fastestTurns = turn
    }
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
    return { exit, skipped, reason: "" }
  }

  /**
   * An exit with the average of its recent round trips attached.
   *
   * The fastest strategy compares this rather than the last round trip: a
   * single long generation is not a slow exit, and the exit that was slow
   * once must still be able to be picked again to prove otherwise.
   */  private withSpeed<T extends ExitRecord>(exit: T): T & { readonly averageMs?: number } {
    const average = this.statsFor(exit.id).averageMs
    return average === undefined ? exit : { ...exit, averageMs: average }
  }

  /**
   * Write where the rotation stands, at most every few seconds.
   *
   * A restart that always starts the rotation at the first exit would let
   * that one burn its allowance first every time. The position is written
   * with the rules, at most once every few seconds, so a busy session does
   * not write a file per request.
   */
  private rememberRotation(): void {
    const id = this.lastServedId
    const now = Date.now()
    if (now - this.lastRotationWrite < ROTATION_WRITE_MS) return
    this.lastRotationWrite = now
    // The position goes into the rules, so it is written with them and it
    // survives a restart.
    void this.writeRules(() => ({ ...this.rules, rotationId: id })).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      this.noteFailure(`The rotation could not be remembered: ${message}`)
    })
  }

  /**
   * Persist a verdict that has to land, and say so when it does not.
   *
   * A verdict that is only in memory is lost at the next restart, and the
   * exit comes back as if it had never failed. The user is told instead: a
   * silent divergence between what the menu says and what the disk holds is
   * worse than a loud one.
   */
  private persistVerdict(next: ExitRecord, what: string): void {
    void this.replaceExit(next).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      this.noteFailure(`The ${what} could not be saved: ${message}`)
    })
  }

  /** Remember that an exit did not answer.
   *
   * The wait starts at two minutes and doubles with every consecutive failure,
   * capped at thirty minutes; one success clears it. A single dropped
   * connection should not sideline an exit for the session, and an exit that
   * keeps failing should not be tried on every request.
   */
  markFailure(id: string, note?: string, status: ExitStatus = "unreachable"): void {
    const exit = this.exit(id)
    if (!exit) return
    const rested = this.rest(id)
    this.bumpHealthEpoch(id)
    // The rest is written with the status in one replaceExit, so a crash
    // cannot persist a live failure whose rest is lost: a restart would
    // otherwise read the failure as a test verdict and skip the exit forever.
    const next: ExitRecord = {
      ...exit,
      status: this.failureStatus(exit, status),
      coolingUntil: rested.until,
      failures: rested.failures,
      ...(note !== undefined ? { lastError: this.scrub(note).slice(0, 240) } : {}),
    }
    this.persistVerdict(next, "failure")
  }

  /** Arm the next rest for this exit, twice as long as the one before. */
  private rest(id: string): { until: number; failures: number } {
    const previous = this.cooling.get(id)?.failures ?? 0
    const failures = previous + 1
    const wait = Math.min(COOLDOWN_BASE_MS * 2 ** (failures - 1), COOLDOWN_MAX_MS)
    const entry = { until: Date.now() + wait, failures }
    this.cooling.set(id, entry)
    return entry
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
    // The runtime is the exit's own word about itself, and it is drawn on the
    // exit's page: it is stripped here, once, so no path can bring an escape
    // sequence to the screen.
    const safeRuntime = exitReportedText(runtime)
    const next: ExitRecord = {
      ...exit,
      ...(egress !== undefined ? { egress } : {}),
      ...(safeRuntime !== undefined ? { runtime: safeRuntime } : {}),
    }
    if (next.kind === "relay") {
      this.relayList = this.relayList.map((relay) => (relay.id === id ? next : relay))
    } else {
      this.proxyList = this.proxyList.map((proxy) => (proxy.id === id ? next : proxy))
    }
  }

  /**
   * Mark an exit as tested by the user.
   *
   * An imported exit stays out of service until the user tests it: an
   * automatic check must not put a shared configuration's address into live
   * routing, where the first real request would carry the user's session
   * token to it.
   */
  async markTested(id: string): Promise<void> {
    const exit = this.exit(id)
    if (exit === undefined || exit.imported !== true) return
    const { imported: _imported, ...rest } = exit
    const next = rest as ExitRecord
    if (exit.kind === "relay") {
      this.relayList = this.relayList.map((relay) =>
        relay.id === id ? (next as RelayRecord) : relay,
      )
    } else {
      this.proxyList = this.proxyList.map((proxy) =>
        proxy.id === id ? (next as ProxyRecord) : proxy,
      )
    }
    try {
      await this.replaceExit(next)
    } catch (error) {
      // The write did not land, so the mark goes back: memory must not say
      // the exit is tested when the disk still says imported — the next
      // restart would read the mark back and the menu would not lie, but the
      // running process would serve an address it never vetted.
      const marked: ExitRecord = { ...next, imported: true }
      if (marked.kind === "relay") {
        this.relayList = this.relayList.map((relay) =>
          relay.id === id ? (marked as RelayRecord) : relay,
        )
      } else {
        this.proxyList = this.proxyList.map((proxy) =>
          proxy.id === id ? (marked as ProxyRecord) : proxy,
        )
      }
      throw error
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
    // A success is live evidence too, so every check already in flight is out
    // of date. The tester stamps an epoch when its check starts, so its own
    // answer was never in flight against this verdict; only an older check is.
    this.bumpHealthEpoch(id)
    // A success after a failure has to be remembered: the record on disk still
    // carries the failure verdict and its rest, and a restart would read it
    // back and sideline an exit that just served a request. When the record is
    // already clean, later successes only update memory, so a healthy stretch
    // is not a disk write per request.
    if (
      exit.status !== "ready" ||
      exit.coolingUntil !== undefined ||
      exit.failures !== undefined ||
      exit.exhaustedUntil !== undefined ||
      exit.lastError !== undefined
    ) {
      // The keys are removed rather than set to null-ish, so the stored JSON
      // keeps its optional fields optional. The old failure note goes too:
      // a "ready" record that still carried the last error's text would have
      // the menu show an error under a healthy status.
      const {
        exhaustedUntil: _until,
        coolingUntil: _cooling,
        failures: _failures,
        lastError: _error,
        ...cleared
      } = exit
      const next: ExitRecord = {
        ...cleared,
        status: "ready",
        lastCheck: Date.now(),
        ...(measured !== undefined ? { latencyMs: measured } : {}),
      }
      this.persistVerdict(next, "result")
      return
    }
    // The in-memory record is what the menu and the fastest strategy read.
    const next: ExitRecord = {
      ...exit,
      lastCheck: Date.now(),
      ...(measured !== undefined ? { latencyMs: measured } : {}),
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
    // A used-up verdict is live evidence: a check that began before it must not
    // bring the exit back with an answer of its own.
    this.bumpHealthEpoch(id)
    // The used-up verdict is the stronger one, so an older rest goes with it:
    // the rest of a rate limit would otherwise keep the exit out of use after
    // the allowance is back, and a restart would restore a rest the running
    // process was not enforcing.
    this.cooling.delete(id)
    const {
      coolingUntil: _cooling,
      failures: _failures,
      ...rest
    } = exit
    const next: ExitRecord = {
      ...rest,
      status: "exhausted",
      exhaustedUntil: until,
      lastCheck: Date.now(),
      ...(note !== undefined ? { lastError: this.scrub(note).slice(0, 240) } : {}),
    }
    if (next.kind === "relay") {
      this.relayList = this.relayList.map((relay) => (relay.id === id ? next : relay))
    } else {
      this.proxyList = this.proxyList.map((proxy) => (proxy.id === id ? next : proxy))
    }
    void (next.kind === "relay"
      ? this.enqueueWrite(RELAYS_KEY, () => writeRelays(this.storage, this.relayList))
      : this.enqueueWrite(PROXIES_KEY, () => writeProxies(this.storage, this.proxyList))
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      this.noteFailure(`The used-up exit could not be remembered: ${message}`)
    })
    // The change goes through the rules writer, which applies it to memory
    // and takes it back if the write does not land: the state must not name
    // an exit the disk does not. Assigning before the writer would leave a
    // rollback with nothing to compare against.
    //
    // The whole decision lives in the builder. The rules in memory are only
    // what the last write left there, so a check made out here would read
    // them as they were before this tick's writes landed: two exits giving
    // out in the same tick would both see the same preference, and the
    // second would name an exit that is already used up. Inside the builder
    // the rules are the current ones, and the chain keeps another rule write
    // from landing in between.
    void this.writeRules((current) => {
      if (current.strategy !== "exhausted") return current
      if (current.activeExitId !== id) return current
      const chosen = this.pickExit({ advance: false }).exit
      if (chosen === undefined) return current
      return { ...current, activeExitId: chosen.id }
    }).catch((error: unknown) => {
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
        const { exhaustedUntil: _until, coolingUntil: _cooling, failures: _failures, ...rest } = exit
        const next: ExitRecord = { ...rest, status: "reachable" }
        // The rest goes with the latch: the record no longer carries it, so
        // the live map must not keep it either.
        this.cooling.delete(exit.id)
        if (next.kind === "relay") {
          this.relayList = this.relayList.map((relay) => (relay.id === exit.id ? next : relay))
        } else {
          this.proxyList = this.proxyList.map((proxy) => (proxy.id === exit.id ? next : proxy))
        }
      }
      void Promise.all([
        this.enqueueWrite(RELAYS_KEY, () => writeRelays(this.storage, this.relayList)),
        this.enqueueWrite(PROXIES_KEY, () => writeProxies(this.storage, this.proxyList)),
      ]).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        this.noteFailure(`The used-up exits could not be cleared: ${message}`)
      })
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
  /**
   * Bring the used-up exits back into use now, and say what could not be.
   *
   * The addresses that were marked as spent are left alone by default: they
   * are a fact about the address, not about the relay, and a relay that
   * comes back to a spent address is refused again at once. `recycle` names
   * the addresses the caller has decided to forgive — an explicit restore is
   * that decision — and those are cleared, so the relay can be asked to move
   * to a fresh one.
   *
   * Returns the exits that were restored and, separately, the ones left out:
   * either because the window the provider gave is still live and the caller
   * chose not to forgive them, or because their write did not land and they
   * were rolled back.
   */
  async restoreExhausted(recycle?: (egress: string) => boolean): Promise<{
    readonly restored: readonly string[]
    readonly stillUsedUp: readonly string[]
    /**
     * The proxies could not be written. The relays were, and they stay
     * restored: the caller is told, and the answer carries both.
     */
    readonly failed?: StorageError
  }> {
    const restored: string[] = []
    const stillUsedUp: string[] = []
    const restoredRelays = new Set<string>()
    const restoredProxies = new Set<string>()
    // The records as they were, so a failed write can put them back whole:
    // the latch is the only thing keeping a spent address out of service,
    // and a rollback that kept the status but dropped the latch would let
    // the picker route through the exact allowance the provider refused.
    const beforeRelays = new Map(this.relayList.map((relay) => [relay.id, relay]))
    const beforeProxies = new Map(this.proxyList.map((proxy) => [proxy.id, proxy]))
    // The egresses this call forgives are remembered, so only they go back
    // into the spent map on a rollback: rewinding the whole map would erase
    // an address another writer spent meanwhile.
    const forgivenEgresses: string[] = []
    // The addresses the proxies leave from, kept apart: the proxies can be
    // rolled back on their own, and their addresses have to go back with
    // them.
    const forgivenProxyEgresses: string[] = []
    // The windows the spent addresses had, taken before anything forgives
    // them: the provider's own window is what a rollback has to restore, and
    // one this plugin made up would shorten it.
    const beforeSpent = new Map<string, number | undefined>()
    for (const exit of this.exits()) {
      if (exit.status !== "exhausted") continue
      if (exit.egress === undefined) continue
      if (!beforeSpent.has(exit.egress)) beforeSpent.set(exit.egress, this.spent.get(exit.egress))
    }
    const beforeCooling = new Map(
      this.exits().map((exit) => [exit.id, this.cooling.get(exit.id)] as const),
    )
    const beforeCursor = this.cursor
    const forgive = (egress: string | undefined): boolean =>
      egress !== undefined && recycle !== undefined && recycle(egress)
    this.relayList = this.relayList.map((relay) => {
      if (relay.status !== "exhausted") return relay
      // An exit that leaves from an address whose window is still live goes
      // back to the same refusal unless its address is forgiven here.
      if (!forgive(relay.egress) && (relay.exhaustedUntil ?? 0) > Date.now()) {
        stillUsedUp.push(relay.id)
        return relay
      }
      restored.push(relay.id)
      restoredRelays.add(relay.id)
      if (relay.egress !== undefined && forgive(relay.egress)) {
        this.spent.delete(relay.egress)
        forgivenEgresses.push(relay.egress)
      }
      this.cooling.delete(relay.id)
      // A restore is live evidence too: a check that began before it must
      // not re-mark the exit used up with an answer of its own.
      this.bumpHealthEpoch(relay.id)
      const { exhaustedUntil: _until, coolingUntil: _cooling, failures: _failures, ...rest } = relay
      return { ...rest, status: "reachable" as Status }
    })
    this.proxyList = this.proxyList.map((proxy) => {
      if (proxy.status !== "exhausted") return proxy
      if (!forgive(proxy.egress) && (proxy.exhaustedUntil ?? 0) > Date.now()) {
        stillUsedUp.push(proxy.id)
        return proxy
      }
      restored.push(proxy.id)
      restoredProxies.add(proxy.id)
      if (proxy.egress !== undefined && forgive(proxy.egress)) {
        this.spent.delete(proxy.egress)
        forgivenEgresses.push(proxy.egress)
        forgivenProxyEgresses.push(proxy.egress)
      }
      this.cooling.delete(proxy.id)
      this.bumpHealthEpoch(proxy.id)
      const { exhaustedUntil: _until, coolingUntil: _cooling, failures: _failures, ...rest } = proxy
      return { ...rest, status: "reachable" as Status }
    })
    this.cursor = 0
    if (restored.length === 0) return { restored, stillUsedUp }
    /**
     * Put every restored exit back exactly as it was, record and live map
     * entries included. The epoch is not rewound: a bump is monotonic, and
     * lowering it would let a check that started before a live verdict
     * overwrite that verdict. The spent map does not lose what another
     * writer put there: only the egresses this call forgave go back, and
     * they go back with the window the provider gave them.
     */
    const undo = (): void => {
      this.relayList = this.relayList.map((relay) =>
        restoredRelays.has(relay.id) ? (beforeRelays.get(relay.id) as RelayRecord) : relay,
      )
      this.proxyList = this.proxyList.map((proxy) =>
        restoredProxies.has(proxy.id) ? (beforeProxies.get(proxy.id) as ProxyRecord) : proxy,
      )
      for (const egress of forgivenEgresses) {
        const until = beforeSpent.get(egress)
        if (until === undefined) this.spent.delete(egress)
        else this.spent.set(egress, until)
      }
      // Only the exits this call touched go back: a rest another writer armed
      // meanwhile is not this call's to undo.
      for (const id of [...restoredRelays, ...restoredProxies]) {
        const entry = beforeCooling.get(id)
        if (entry === undefined) this.cooling.delete(id)
        else this.cooling.set(id, entry)
      }
      this.cursor = beforeCursor
    }
    try {
      await this.enqueueWrite(RELAYS_KEY, () => writeRelays(this.storage, this.relayList))
    } catch (error) {
      // The relays were not written, so everything this call changed goes
      // back exactly as it was: the records, the latches and the live maps.
      // The proxies have not been touched yet.
      undo()
      throw error
    }
    try {
      await this.enqueueWrite(PROXIES_KEY, () => writeProxies(this.storage, this.proxyList))
    } catch (error) {
      // The proxies were not written, so they go back to being used up, and
      // the addresses they left from go back to being spent: an address the
      // provider refused is what keeps the other exits off it. The relays
      // were written, so they stay as they are: a rollback of both would
      // leave the disk saying something the memory does not.
      this.proxyList = this.proxyList.map((proxy) =>
        restoredProxies.has(proxy.id) ? (beforeProxies.get(proxy.id) as ProxyRecord) : proxy,
      )
      for (const egress of forgivenProxyEgresses) {
        const until = beforeSpent.get(egress)
        if (until === undefined) this.spent.delete(egress)
        else this.spent.set(egress, until)
      }
      for (const id of restoredProxies) {
        const entry = beforeCooling.get(id)
        if (entry === undefined) this.cooling.delete(id)
        else this.cooling.set(id, entry)
      }
      // The message does not repeat the key prefix: the StorageError the
      // caller sees already names the proxies, and the useful part is what
      // did land.
      //
      // Only the relays stayed restored: the proxies were rolled back and
      // are still out of use, so reporting them as restored would claim
      // exits the next request cannot use. They are named with the exits
      // that were left out instead.
      for (const id of restoredProxies) stillUsedUp.push(id)
      return {
        restored: restored.filter((id) => restoredRelays.has(id)),
        stillUsedUp,
        failed: new StorageError(
          "proxies",
          `${error instanceof Error ? error.message : String(error)} The relays were restored.`,
        ),
      }
    }
    return { restored, stillUsedUp }
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

  /**
   * When an address is known to be used up, and until when.
   *
   * The window the provider gave is the one that counts: an exit that sits
   * on a spent address must not be retired for longer than the provider
   * said, and the window must not be pushed further out.
   */
  spentUntil(egress: string, now = Date.now()): number | undefined {
    const until = this.spent.get(egress)
    if (until === undefined || until <= now) return undefined
    return until
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
   * this note and the retry hook reads it. A new request clears the note first,
   * so the window only has to outlast a slow answer, however long that is.
   *
   * The kind of request is part of the key. A session's title request runs
   * beside its agent loop and uses the same model, so without the kind the
   * title would take the loop's timing and the loop's answer would be timed
   * from the title's start.
   */
  noteRelayed(sessionID: string, modelID: string, exitId: string, kind = PRIMARY_KIND): void {
    const now = Date.now()
    if (this.relayed.size > 200) {
      for (const [key, entry] of this.relayed) {
        if (now - entry.at > ATTRIBUTION_TTL_MS) this.relayed.delete(key)
      }
    }
    const key = attributionKey(sessionID, modelID, kind)
    this.relayed.set(key, { at: now, exitId })
    this.direct.delete(key)
  }

  /**
   * A request that did not go through an exit must not inherit the last one's
   * blame.
   *
   * The note is marked as "went direct" rather than simply removed: the retry
   * hook looks for the agent loop's exit and falls back to another kind's note
   * when the loop has none, and a request that went direct must not be
   * charged to the exit that served the session's title.
   */
  forgetRelayed(sessionID: string, modelID: string, kind = PRIMARY_KIND): void {
    const key = attributionKey(sessionID, modelID, kind)
    this.relayed.delete(key)
    this.failures.delete(key)
    this.started.delete(key)
    this.direct.add(key)
    // The set carries no timestamps, so the oldest entry goes first: it is
    // only ever read for the session and model being asked about.
    if (this.direct.size > 200) {
      const oldest = this.direct.values().next().value
      if (oldest !== undefined) this.direct.delete(oldest)
    }
  }

  /**
   * Which exit served this session and model a moment ago, if one did.
   *
   * The retry hook is not told which kind of request failed, and a session's
   * title request runs beside its agent loop with the same model. The agent
   * loop is the one that fails often enough to matter, so its note is taken
   * first: a title must not take the loop's blame. The newest note of any
   * kind is the fallback, for a session whose only routed request was a
   * title.
   */
  relayedBy(sessionID: string, modelID: string, now = Date.now()): string | undefined {
    const primaryKey = attributionKey(sessionID, modelID, PRIMARY_KIND)
    const primary = this.relayed.get(primaryKey)
    if (primary !== undefined && now - primary.at <= ATTRIBUTION_TTL_MS) return primary.exitId
    // The agent loop went direct, so there is no exit to blame: another kind's
    // note belongs to another request.
    if (this.direct.has(primaryKey)) return undefined
    let newest: { readonly at: number; readonly exitId: string } | undefined
    const prefix = attributionPrefix(sessionID, modelID)
    for (const [key, entry] of this.relayed) {
      if (!key.startsWith(prefix)) continue
      if (now - entry.at > ATTRIBUTION_TTL_MS) continue
      if (newest === undefined || entry.at >= newest.at) newest = entry
    }
    return newest?.exitId
  }

  /** The moment a routed request started, and the exit it went through. */
  noteStarted(sessionID: string, modelID: string, exitId: string, kind = PRIMARY_KIND): void {
    const now = Date.now()
    // The entry is cleared when the answer arrives, but a rewrite that threw,
    // or an answer the hook never saw, leaves it behind: the map is pruned on
    // the same bound the other attribution maps keep, so a long session does
    // not grow it without end.
    if (this.started.size > 200) {
      for (const [key, entry] of this.started) {
        if (now - entry.at > ATTRIBUTION_TTL_MS) this.started.delete(key)
      }
    }
    this.started.set(attributionKey(sessionID, modelID, kind), { at: now, exitId })
  }

  /** How long the routed request took, when the answer arrived. */
  finishTiming(sessionID: string, modelID: string, kind = PRIMARY_KIND): number | undefined {
    const key = attributionKey(sessionID, modelID, kind)
    const started = this.started.get(key)
    this.started.delete(key)
    return started === undefined ? undefined : Date.now() - started.at
  }

  /** What the last answer for this session and model said, for the retry hook. */
  noteFailureContext(
    sessionID: string,
    modelID: string,
    context: FailureContext,
    kind = PRIMARY_KIND,
  ): void {
    if (this.failures.size > 200) {
      const now = Date.now()
      for (const [key, entry] of this.failures) {
        if (now - entry.at > 60_000) this.failures.delete(key)
      }
    }
    this.failures.set(attributionKey(sessionID, modelID, kind), context)
  }

  /**
   * The exit the agent loop's own request used, when the retry hook can be
   * certain of it.
   *
   * A session's title request runs beside its agent loop with the same
   * model, and the retry hook is told neither: resting a title's exit for
   * the loop's failure would keep retrying a broken one, and resting the
   * loop's exit for a title's failure would bench a working one. Only the
   * loop's own marks count — the request it started, the answer recorded
   * for it, or a note a caller left without driving the request hook. The
   * two marks name the exit when they agree, either one names it alone, and
   * anything else is not certain.
   */
  primaryExitForRetry(sessionID: string, modelID: string, now = Date.now()): string | undefined {
    const key = attributionKey(sessionID, modelID, PRIMARY_KIND)
    const started = this.started.get(key)
    const failure = this.failures.get(key)
    const liveStart =
      started !== undefined && now - started.at <= ATTRIBUTION_TTL_MS ? started : undefined
    const liveFailure =
      failure !== undefined && now - failure.at <= 60_000 ? failure : undefined
    if (liveStart !== undefined && liveFailure !== undefined) {
      return liveStart.exitId === liveFailure.exitId ? liveStart.exitId : undefined
    }
    if (liveStart !== undefined) return liveStart.exitId
    if (liveFailure !== undefined) return liveFailure.exitId
    const relayed = this.relayed.get(key)
    if (relayed !== undefined && now - relayed.at <= ATTRIBUTION_TTL_MS) return relayed.exitId
    return undefined
  }

  /**
   * The failure the retry hook is about, when it belongs to a routed request.
   *
   * The agent loop's answer is taken first, for the same reason as the
   * relayed note: a title request's failure must not decide what the loop's
   * retry does. The newest of any kind is the fallback.
   */
  failureFor(sessionID: string, modelID: string): FailureContext | undefined {
    const primaryKey = attributionKey(sessionID, modelID, PRIMARY_KIND)
    const primary = this.failures.get(primaryKey)
    if (primary !== undefined) {
      if (Date.now() - primary.at <= 60_000) return primary
      this.failures.delete(primaryKey)
    }
    // The agent loop went direct, so it has no failure of its own to report.
    if (this.direct.has(primaryKey)) return undefined
    let newest: FailureContext | undefined
    const prefix = attributionPrefix(sessionID, modelID)
    for (const [key, entry] of this.failures) {
      if (!key.startsWith(prefix)) continue
      if (Date.now() - entry.at > 60_000) {
        this.failures.delete(key)
        continue
      }
      if (newest === undefined || entry.at >= newest.at) newest = entry
    }
    return newest
  }

  /** A real request, kept so a test can look like OpenCode Free. */
  noteSample(sample: Omit<RequestSample, "at">): void {
    this.sample = { ...sample, at: Date.now() }
  }

  /**
   * The last real request, when it is recent enough to be representative.
   *
   * The deep test replays the headers of a routed request, so a deep test
   * without one cannot carry the session token and proves nothing.
   */
  hasRequestSample(maxAgeMs = 30 * 60_000): boolean {
    return this.requestSample(maxAgeMs) !== undefined
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

  /**
   * Whether another attempt after a used-up answer can reach an exit that
   * still works.
   *
   * `bridgeReady` says whether the local proxy bridge is running: a proxy
   * without it cannot carry a request, so counting one would promise a way
   * out that is not there, and the retry would fail for a different reason
   * than the one it was given for.
   */
  canRetryAfterAllowance(bridgeReady = true): boolean {
    const pick = this.pickExit({
      advance: false,
      ...(bridgeReady ? {} : { exclude: proxyExclusions(this) }),
    })
    return pick.exit !== undefined
  }

  /** Every exit as the terminal UI sees it. */
  summaries(): ExitSummary[] {
    return this.exits().map((exit) => {
      const reason = exit.egress !== undefined ? this.spendReason(exit.egress) : undefined
      return toExitSummary(exit, this.statsFor(exit.id), reason)
    })
  }
}
