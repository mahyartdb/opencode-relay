/**
 * The RPC the terminal part talks to.
 *
 * Every handler here is one the contract in src/rpc.ts declares. The handlers
 * own no state of their own: they read and write the state object they are
 * given, and every change is announced so the terminal part can refresh.
 *
 * The unit they manage is the *exit*: a Vercel relay or a proxy. The two are
 * kept in different lists because they are deployed and edited differently,
 * but every routing decision treats them as one pool.
 */
import { randomBytes, randomUUID } from "node:crypto"
import type { RpcHandlers } from "@opencode/plugin/promise/rpc"
import { Relay } from "../rpc.ts"
import {
  PROVIDER_ID,
  REGIONS,
  displayUrl,
  regionLabel,
  toAccountSummary,
  toExitSummary,
  type Account,
  type AccountPlan,
  type DeployedRelay,
  type DirectPolicy,
  type ExitRecord,
  type ExitSummary,
  type ProxyRecord,
  type RelayRecord,
  type Selection,
  type Strategy,
} from "../lib/types.ts"
import { isFree, isSafeRelayUrl, normalizeRelayUrl, selectModels } from "../lib/routing.ts"
import { parseProxyList, parseProxyUrl, proxyKey, type ParsedProxy } from "../lib/proxy.ts"
import { redact } from "../lib/redact.ts"
import {
  deleteVercelProject,
  deployRelay as deployToVercel,
  inspectVercel,
  probeRelay,
  VercelError,
} from "../lib/vercel.ts"
import { projectName, relaySource } from "../lib/relay-source.ts"
import type { ProxyBridge } from "./bridge.ts"
import { decideModel } from "./decide.ts"
import type { ModelCatalog } from "./models.ts"
import type { RelayState, Settings } from "./state.ts"
import { StorageError, proxyExclusions } from "./state.ts"
import type { Tester } from "./tester.ts"

/** Everything the handlers need from the outside world. */
export interface HandlerDeps {
  readonly state: RelayState
  readonly catalog: ModelCatalog
  readonly bridge: ProxyBridge
  readonly tester: Tester
  /** Announces that something changed, so the terminal part can refresh. */
  readonly announce: (reason: string) => Promise<void>
}

/** The message of a failure. */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A short tail for the project name, so two relays in one region never share a project. */
function projectSuffix(name: string | undefined): string {
  return `${name ?? ""}-${randomBytes(3).toString("hex")}`
}

/**
 * Say that something changed, without risking the answer.
 *
 * Every announcement happens after the change has landed: a failed event
 * dispatch must not reject an RPC whose change is already in force, or the
 * user would be told it failed and repeat it — a second deployment in the
 * same region, for instance.
 */
function announceChanged(announce: (reason: string) => Promise<void>, reason: string): void {
  void announce(reason).catch(() => {})
}

/** The access token a relay requires. It is a secret, so it is not guessable. */
function newAccessToken(): string {
  return randomBytes(24).toString("hex")
}

/** The largest configuration the import will read, before it is parsed. */
const IMPORT_LIMIT_BYTES = 2 * 1024 * 1024

/**
 * How many relays and proxies one import may add.
 *
 * Every exit that is added is checked afterwards, one after the other, and a
 * check is a request to whatever address the file named. A list of tens of
 * thousands would keep the plugin busy for hours, against addresses nobody
 * chose.
 */
const IMPORT_RELAY_LIMIT = 200
const IMPORT_PROXY_LIMIT = 1000

/** A proxy's default name: its address, which is what the user recognizes. */
function proxyName(host: string, port: number, index: number, prefix?: string): string {
  const address = `${host}:${port}`
  return prefix !== undefined && prefix.length > 0 ? `${prefix} ${index + 1}` : address
}

/** A Vercel account behind a relay, when it is still stored. */
function accountOf(state: RelayState, relay: RelayRecord): Account | undefined {
  return relay.accountId.length > 0 ? state.account(relay.accountId) : undefined
}

/**
 * Keep the stored credentials when the new address brings none.
 *
 * The address a user edits is shown with its credentials masked, so it cannot
 * be prefilled into the field. A user who changes only the port would then
 * hand over an address with no credentials at all, and the proxy would
 * quietly stop authenticating. Credentials that the new address does not
 * carry are therefore kept from the one it replaces - but only for the same
 * host: handing one provider's password to another host is worse than
 * dropping it.
 */
function keepCredentials(parsed: ParsedProxy, previous: string): string {
  if (parsed.username !== undefined) return parsed.url
  const before = parseProxyUrl(previous)
  if (before?.username === undefined) return parsed.url
  if (before.host.toLowerCase() !== parsed.host.toLowerCase()) return parsed.url
  // The credentials are taken from the stored address as they are: they are
  // already encoded, and encoding them a second time would change them.
  const schemeEnd = previous.indexOf("://")
  const at = previous.indexOf("@")
  if (schemeEnd < 0 || at < schemeEnd) return parsed.url
  const userinfo = previous.slice(schemeEnd + 3, at)
  const host = parsed.host.includes(":") ? `[${parsed.host}]` : parsed.host
  return `${parsed.scheme}://${userinfo}@${host}:${parsed.port}`
}

/** A sentence for the user, saying what the plugin is doing right now. */
function describeState(options: {
  readonly settings: Settings
  readonly exits: readonly ExitSummary[]
  /** The exit the user chose, when there is one. */
  readonly active: ExitSummary | undefined
  /**
   * The exit the picker would actually use for the next request, derived from
   * the same predicate the request hook takes, or undefined when no exit can
   * serve and the request goes direct. The note must never name an exit the
   * picker would reject.
   */
  readonly serving: ExitSummary | undefined
  readonly routed: number
  readonly modelCount: number
  /** Requests that have gone through an exit since the process started. */
  readonly requests: number
  readonly catalog: ModelCatalog
  readonly notes: readonly string[]
  readonly exhausted: readonly string[]
  /** The exits that are cooling down right now. */
  readonly skipped: readonly string[]
  /**
   * The exits the picker leaves out, and why.
   *
   * The reasons are the picker's own: an exit that is rate-limited did
   * answer, and one that OpenCode refuses did not fail to answer, so the
   * note has to say which it is.
   */
  readonly pickSkipped?: readonly { readonly id: string; readonly reason: string }[]
}): string {
  const { settings, exits, active, serving, routed, modelCount, requests, catalog, notes, exhausted, skipped } =
    options
  if (!settings.enabled) return "Routing is off: requests go straight to OpenCode."
  if (exits.length === 0) return "Routing is on, but there is no relay or proxy yet."

  const models = modelCount === 0 ? "no model" : `${routed} free ${PROVIDER_ID} model${routed === 1 ? "" : "s"}`
  // How many requests actually went through an exit, which is the number the
  // user asks for. The count of selected models is not that number: with
  // routing off, or on a provider that is not routed, it can be large while
  // nothing has ever left through an exit.
  const traffic =
    requests === 0
      ? "No request has gone through an exit yet."
      : `${requests} request${requests === 1 ? "" : "s"} ${requests === 1 ? "has" : "have"} gone through an exit.`
  const problems: string[] = [traffic]
  if (catalog.lastFailure()) {
    problems.push("The model list could not be read, so no model is known to be free.")
  }
  if (exhausted.length > 0) {
    problems.push(`${exhausted.length} exit${exhausted.length === 1 ? " is" : "s are"} used up.`)
  }
  const otherSkipped = skipped.filter((id) => id !== active?.id)
  if (otherSkipped.length > 0) {
    // Why each skipped exit sits out, in words. The exhausted ones are already
    // counted in their own sentence above, so they are left out here rather
    // than reported twice. The active exit was handled further up: it is the
    // one another exit takes over from.
    const counted = new Set(exhausted)
    const paused: string[] = []
    const limited: string[] = []
    const untested: string[] = []
    const failing: string[] = []
    const silent: string[] = []
    for (const id of otherSkipped) {
      if (counted.has(id)) continue
      const exit = exits.find((entry) => entry.id === id)
      if (exit === undefined) continue
      if (!exit.enabled) paused.push(exit.name)
      else if (exit.status === "limited") limited.push(exit.name)
      else if (exit.status === "exhausted") continue
      else if (exit.status === "untested" || exit.status === "unknown") untested.push(exit.name)
      else if (exit.status === "blocked") {
        // A refusal is its own sentence: "did not answer" would be false, and
        // the user needs to know OpenCode itself turned the exit away.
        problems.push(`${exit.name} is blocked by OpenCode, so it is skipped.`)
      } else if (exit.status === "bad") {
        // The exit answered with an error, which is not the same as not
        // answering: its own lastError says what came back.
        failing.push(exit.name)
      } else silent.push(exit.name)
    }
    const groups: Array<{ readonly verdict: readonly [string, string]; readonly names: readonly string[] }> = [
      { verdict: ["is paused", "are paused"], names: paused },
      { verdict: ["is rate-limited", "are rate-limited"], names: limited },
      { verdict: ["has not been tested yet", "have not been tested yet"], names: untested },
      { verdict: ["is failing", "are failing"], names: failing },
      { verdict: ["did not answer", "did not answer"], names: silent },
    ]
    for (const { verdict, names } of groups) {
      if (names.length === 0) continue
      problems.push(
        names.length === 1
          ? `${names[0]} ${verdict[0]}, so it is skipped.`
          : `${names.join(", ")} ${verdict[1]}, so they are skipped.`,
      )
    }
  }
  problems.push(...notes)

  // Nothing is routed: whatever the exits look like, no request will leave
  // through one. The pill and the summary say the same, so every surface
  // agrees instead of the note promising routing that cannot happen. This is
  // checked before the serving exit, so both being true does not promise
  // "routing through X" under a pill that says "nothing routed".
  if (routed === 0) {
    // A catalog failure already has its own sentence in `problems`; a second
    // explanation would say the same thing twice.
    const why =
      catalog.lastFailure() !== undefined
        ? undefined
        : settings.selection === "custom"
          ? "no chosen model is free"
          : "the provider lists no free model"
    const note =
      why === undefined
        ? "Routing is on, but nothing is routed."
        : `Routing is on, but nothing is routed (${why}).`
    return problems.length === 0 ? note : `${note} ${problems.join(" ")}`
  }

  if (serving === undefined) {
    const fallback =
      settings.direct === "never"
        ? "The plugin is set to never go direct, so requests fail."
        : "Requests go direct."
    const note = `Routing is on, but no exit can serve a request right now. ${fallback}`
    return problems.length === 0 ? note : `${note} ${problems.join(" ")}`
  }

  const where =
    settings.strategy === "round-robin"
      ? "across the exits in turn"
      : settings.strategy === "fastest"
        ? "through the fastest exit"
        : `through ${serving.name}`
  // The chosen exit is only named when it is the one that did not answer and
  // another takes over; otherwise the note names the exit that will serve.
  // The strategy reads as words, not as its stored id: "Routing ... (fixed)"
  // said nothing to a reader who never opened the settings.
  // The chosen exit is only named when the picker leaves it out and another
  // takes over; otherwise the note names the exit that will serve. The
  // reason is the picker's own, so a rate-limited exit is not said to have
  // failed to answer.
  const activeSkipped = options.pickSkipped?.find((entry) => entry.id === active?.id)
  const chosenSkipped = active !== undefined && active.id !== serving.id && activeSkipped !== undefined
  const how =
    settings.strategy === "fixed"
      ? "one exit preferred"
      : settings.strategy === "exhausted"
        ? "until it is exhausted"
        : undefined
  const note = chosenSkipped
    ? `Routing ${models}: ${active.name} cannot serve right now (${activeSkipped.reason}), so ${serving.name} takes over.`
    : how !== undefined
      ? `Routing ${models} ${where} (${how}).`
      : `Routing ${models} ${where}.`
  return problems.length === 0 ? note : `${note} ${problems.join(" ")}`
}

/**
 * A name the terminal can show.
 *
 * The name of an imported exit comes from a file, and a file may carry
 * control characters: they would be drawn in the menu, in a toast and on a
 * page, and some of them move the cursor or start an escape sequence.
 */
function safeName(name: string): string {
  return name
    // An escape sequence, whole: the terminal would read it as one.
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * The parts of a relay address the plugin cares about, or nothing.
 *
 * The address is parsed once: an address that cannot be parsed (a port that
 * is not a number, for instance) must be refused with a word the user can
 * act on, not crash the call.
 */
function parseRelayAddress(url: string): URL | undefined {
  try {
    return new URL(url)
  } catch {
    return undefined
  }
}

/** A relay deployed by one handler, with the record that now tracks it. */
async function deployOne(options: {
  readonly state: RelayState
  readonly account: Account
  readonly region: string
  readonly name: string | undefined
  readonly runtime: "bun" | "node" | undefined
}): Promise<DeployedRelay> {
  const { state, account, region, runtime } = options
  const access = newAccessToken()
  const project = projectName({ region, suffix: projectSuffix(options.name) })
  const deployed = await deployToVercel({
    account: {
      token: account.token,
      ...(account.teamId !== undefined ? { teamId: account.teamId } : {}),
    },
    project,
    region,
    ...(runtime !== undefined ? { runtime } : {}),
    access,
    relaySource: relaySource(),
  })
  const relay: RelayRecord = {
    kind: "relay",
    id: randomUUID(),
    name: options.name ?? `Relay in ${regionLabel(region)}`,
    project: deployed.project,
    region: deployed.region,
    url: deployed.url,
    access,
    accountId: account.id,
    // The runtime is kept, so a redeploy uses the same one: a relay deployed
    // with node and redeployed with bun is a different relay.
    ...(runtime !== undefined ? { deployRuntime: runtime } : {}),
    enabled: true,
    status: "untested",
    createdAt: Date.now(),
  }
  try {
    await state.addRelay(relay)
  } catch (error) {
    // The project is live on Vercel even though the record could not be
    // written, so the receipt has to survive: the user must know what to
    // remove, or they deploy a second project in the same region.
    if (error instanceof StorageError) {
      throw new StorageError(
        error.key,
        `The relay was deployed at ${deployed.url} as the project ${deployed.project}, but it could not be saved: ${error.message} Remove that project in Vercel, or add the relay by hand.`,
      )
    }
    throw error
  }
  // The moment the probe started and the epoch it saw: a live verdict while it
  // is in flight makes its answer stale, however recent its own start looks.
  const checkedAt = Date.now()
  const healthEpoch = state.healthEpoch(relay.id)
  const probe = await probeRelay(relay.url, relay.access)
  await recordProbe(state, relay.id, probe, checkedAt, healthEpoch)
  return {
    id: relay.id,
    name: relay.name,
    url: relay.url,
    region: relay.region,
    regionLabel: regionLabel(relay.region),
    reachable: probe.reachable,
  }
}

/**
 * Record what a relay's first check found.
 *
 * A relay that did not answer gets a rest, not a verdict: an exit marked
 * "not answering" without a rest stays out of use until a person tests it,
 * and the user may never know there was a check at all.
 */
async function recordProbe(
  state: RelayState,
  id: string,
  probe: {
    readonly reachable: boolean
    readonly status: number
    readonly ms: number
    readonly egress?: string
    readonly runtime?: string
  },
  checkedAt: number,
  healthEpoch: number,
): Promise<void> {
  if (!probe.reachable) {
    // A relay that answered with a status has a problem of its own (a wrong
    // access token, a 500), which is not the same as one that did not answer.
    // The status word has to say which: "not answering" beside an error that
    // names an HTTP status would contradict itself.
    const note =
      probe.status > 0
        ? `The relay answered with HTTP ${probe.status}.`
        : "The relay did not answer its first check."
    state.markFailure(id, note, probe.status > 0 ? "bad" : "unreachable")
    return
  }
  try {
    await state.setHealth(id, {
      status: "reachable",
      latencyMs: probe.ms,
      ...(probe.egress !== undefined ? { egress: probe.egress } : {}),
      ...(probe.runtime !== undefined ? { runtime: probe.runtime } : {}),
      checkedAt,
      healthEpoch,
    })
  } catch (error) {
    // The relay is stored either way: only its first verdict was lost. The
    // answer must not say the change was lost, or the user would add it
    // again and end up with two exits at the same address.
    state.noteFailure(
      `The first check of the relay could not be saved: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** The handlers of the relay contract. */
export function createHandlers(deps: HandlerDeps): RpcHandlers<typeof Relay> {
  const { state, catalog, bridge, tester, announce } = deps

  /** Check the exits that were just added, in the background. */
  const checkUntested = (): void => {
    const run = async (): Promise<void> => {
      await tester.scan("api")
      if (state.exits().some((exit) => exit.status === "untested")) {
        await tester.scan("api")
      }
    }
    void run().catch((error: unknown) => {
      state.noteFailure(`The new exits could not be checked: ${describe(error)}`)
    })
  }

  return reportStorageFailures({
    /** What the plugin is doing right now: on or off, through which exit, and what it knows. */
    status: async () => {
      const settings = state.settings()
      const list = selectModels(
        await catalog.list(),
        settings.selection,
        settings.customModels,
      )
      const routed = list.filter((model) => model.routed).length
      // Read the reset timers before the summaries, so an exit whose reset has
      // just passed is reported as usable again instead of used up.
      const exhausted = state.exhaustedExits()
      const skipped = state.coolingExits()
      const exits = state.summaries()
      // The traffic the plugin actually sent: this is what the status note
      // reports, not how many models happen to be selected.
      const requests = exits.reduce((sum, exit) => sum + exit.stats.requests, 0)
      const active = state.activeExit()
      const activeSummary = active === undefined ? undefined : state.summaryOf(active.id)
      const paused = exits.filter((exit) => !exit.enabled).map((exit) => exit.id)
      // The exit the picker would use for the next request, from the very same
      // predicate the request hook applies. The note and the TUI are derived
      // from this, so neither can name an exit that is paused, untested or
      // cooling while another one (or no exit at all) actually serves. The
      // live cooldown map never leaves this process, so this payload is the
      // only place the TUI can learn the picker's answer.
      const pick = state.pickExit({
        advance: false,
        // The bridge stops the proxies when it is not running, so they are
        // left out: the status must not name an exit that cannot carry a
        // request.
        ...(bridge.ready ? {} : { exclude: proxyExclusions(state) }),
      })
      // Nothing is routed when no model survives the free-model filter, so
      // there is no exit that will carry a request: naming one would tell
      // the menu that a request would go through it.
      const serving = routed === 0 ? undefined : pick.exit
      const servingSummary = serving === undefined ? undefined : state.summaryOf(serving.id)
      return {
        enabled: settings.enabled,
        selection: settings.selection,
        strategy: settings.strategy,
        direct: settings.direct,
        healthChecks: settings.healthChecks,
        customModels: [...settings.customModels],
        ...(activeSummary !== undefined ? { activeExit: activeSummary } : {}),
        exits,
        accounts: state.accounts().map((account) => toAccountSummary(account)),
        exhausted,
        paused,
        skipped,
        ...(serving !== undefined ? { servingExitId: serving.id } : {}),
        skippedExitIds: pick.skipped.map((entry) => entry.id),
        ...(state.scanning() !== undefined ? { scanning: state.scanning() } : {}),
        ...(state.lastDecision() !== undefined ? { lastDecision: state.lastDecision() } : {}),
        note: describeState({
          settings,
          exits,
          active: activeSummary,
          serving: servingSummary,
          routed,
          modelCount: list.length,
          requests,
          catalog,
          notes: state.notes(),
          exhausted,
          skipped,
          pickSkipped: pick.skipped,
        }),
        routedCount: routed,
        modelCount: list.length,
      }
    },

    /** The models of the OpenCode provider, each flagged free and routed. */
    models: async () => {
      const settings = state.settings()
      const list = selectModels(
        await catalog.list(),
        settings.selection,
        settings.customModels,
      )
      return { models: [...list] }
    },

    /** Add a Vercel account after checking the token and reading its plan. */
    addAccount: async (input, { error }) => {
      // A name that cleans to nothing is not a name: control characters alone
      // would leave an entry the menus cannot show.
      if (safeName(input.name).length === 0) {
        return error("invalid_input_name", "That account name is not usable.", {
          message: "The name has to be text that can be shown in the menu.",
        })
      }
      let plan: AccountPlan
      try {
        plan = await inspectVercel({
          token: input.token,
          ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
        })
      } catch (err) {
        // A refused token, an answer Vercel did not like, and an unreachable
        // Vercel are three different problems. The status says which: a
        // refused token sends the user to check the token, while "Vercel could
        // not be reached" would send them down the wrong path entirely.
        const message = redact(describe(err), [input.token])
        const status = err instanceof VercelError ? err.status : undefined
        if (status === 401 || status === 403) {
          return error("invalid_token", "Vercel did not accept this token.", { message })
        }
        if (status !== undefined) {
          return error("vercel_unreachable", `Vercel answered with HTTP ${status}.`, { message })
        }
        return error("vercel_unreachable", "Vercel could not be reached.", { message })
      }
      const account = await state.addAccount({
        name: safeName(input.name),
        token: input.token,
        ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
        plan: plan.plan,
      })
      announceChanged(announce, "account added")
      return {
        id: account.id,
        name: account.name,
        ...(plan.plan ? { plan: plan.plan } : {}),
        ...(plan.team ? { team: plan.team } : {}),
        teams: plan.teams,
        projectsSampled: plan.projectsSampled,
        projectsMore: plan.projectsMore,
        ...(plan.limits ? { limits: plan.limits } : {}),
      }
    },

    /** Remove a stored account. Relays deployed with it are kept: they run on their own. */
    removeAccount: async (input) => {
      const removed = await state.removeAccount(input.id)
      if (removed) announceChanged(announce, "account removed")
      return { removed }
    },

    /** Deploy a relay to a region with a stored account. */
    deployRelay: async (input, { error }) => {
      const account = state.account(input.accountId)
      if (!account) {
        return error("deploy_failed", "Unknown account.", {
          message: "The account this relay should be deployed with is not there any more.",
        })
      }
      try {
        const deployed = await deployOne({
          state,
          account,
          region: input.region,
          name: input.name !== undefined ? safeName(input.name) : undefined,
          runtime: input.runtime,
        })
        // The announcement is outside the failure mapping: a failed event
        // dispatch must not be read as a refusal by Vercel.
        announceChanged(announce, "relay deployed")
        return deployed
      } catch (err) {
        // A write that did not land is not a refusal by Vercel: the relay may
        // well be live. Saying "Vercel did not accept it" would send the user
        // into a second deployment in the same region.
        if (err instanceof StorageError) throw err
        return error("deploy_failed", "Vercel did not accept the deployment.", {
          message: redact(describe(err), [account.token]),
        })
      }
    },

    /** Deploy the same relay to several regions in one conversation. */
    deployRelays: async (input) => {
      const account = state.account(input.accountId)
      if (!account) {
        return {
          deployed: [],
          failed: input.regions.map((region) => ({
            region,
            message: "The account is not there any more.",
          })),
        }
      }
      const deployed: DeployedRelay[] = []
      const failed: Array<{ region: string; message: string }> = []
      // A shared label across several regions would name every relay the
      // same, and the exits list would be a list of twins. The region makes
      // each entry readable; a single-region deploy keeps the plain label.
      const shared = input.name !== undefined && input.regions.length > 1
      for (const region of input.regions) {
        try {
          deployed.push(
            await deployOne({
              state,
              account,
              region,
              name: shared ? `${input.name} (${regionLabel(region)})` : input.name,
              runtime: input.runtime,
            }),
          )
        } catch (err) {
          // A write that did not land is not a refusal by Vercel: the relay may
          // well be live. The message says so, and the regions that did land
          // keep their receipts: the user must not deploy them all again.
          failed.push({
            region,
            message: redact(describe(err), [account.token]),
          })
        }
      }
      if (deployed.length > 0) announceChanged(announce, "relays deployed")
      return { deployed, failed }
    },

    /** Track a relay that already exists somewhere else. */
    addRelay: async (input, { error }) => {
      // The relay's access token and every OpenCode authorization header go
      // to this address, so a remote address in plain http would send them in
      // the clear. A loopback address is exempt: that is a relay on this
      // machine, where nothing crosses a network.
      const url = normalizeRelayUrl(input.url.trim())
      if (!isSafeRelayUrl(url)) {
        return error("insecure_relay", "A relay address must be https.", {
          message:
            "The relay carries the access token and the request headers; plain http would send them in the clear.",
        })
      }
      // A relay's credential is its access token, not a password in the
      // address. Credentials in the address would be stored, shown on the
      // exit's page and written into an export in the clear. The address is
      // parsed once, and an address that cannot be parsed at all is refused
      // here rather than crashing the call.
      const parsed = parseRelayAddress(url)
      if (parsed === undefined) {
        return error("insecure_relay", "That relay address could not be read.", {
          message: "The address has to be a full https address, with a port that is a number.",
        })
      }
      if (parsed.username.length > 0 || parsed.password.length > 0) {
        return error("insecure_relay", "A relay address must not carry credentials.", {
          message:
            "The relay's access token is asked for separately; a password in the address would be stored in the clear.",
        })
      }
      // A name that cleans to nothing is not a name: control characters alone
      // would leave an entry the menus cannot show.
      if (safeName(input.name).length === 0) {
        return error("invalid_input_name", "That relay name is not usable.", {
          message: "The name has to be text that can be shown in the menu.",
        })
      }
      const relay: RelayRecord = {
        kind: "relay",
        id: randomUUID(),
        name: safeName(input.name),
        // A relay that was brought here was not deployed by this plugin, so it
        // has no project of its own and no account behind it.
        project: "",
        region: input.region ?? "",
        url,
        access: input.access,
        accountId: "",
        enabled: true,
        status: "untested",
        createdAt: Date.now(),
      }
      await state.addRelay(relay)
      // Stamped when the probe starts: a live verdict while it is in flight
      // wins over whatever the probe answers.
      const checkedAt = Date.now()
      const healthEpoch = state.healthEpoch(relay.id)
      const probe = await probeRelay(relay.url, relay.access)
      await recordProbe(state, relay.id, probe, checkedAt, healthEpoch)
      announceChanged(announce, "relay added")
      return {
        id: relay.id,
        name: relay.name,
        url: relay.url,
        region: relay.region,
        regionLabel: regionLabel(relay.region),
        reachable: probe.reachable,
      }
    },

    /** Remove a relay, and optionally delete its Vercel project. */
    removeRelay: async (input) => {
      const relay = state.relay(input.id)
      if (!relay) return { removed: false, projectDeleted: false }
      // The answer must say whether the project really went, because the user
      // asked for it and a failed deletion means it is still running.
      let projectDeleted = false
      let account: Account | undefined
      if (input.deleteProject && relay.project.length > 0) {
        account = accountOf(state, relay)
        if (!account) {
          // A tracked relay has no account, and a deployed relay whose account
          // was removed can no longer be deleted from here. Saying so is better
          // than a success message about a project that is still running.
          state.noteFailure(
            `The Vercel project of ${relay.name} was not deleted: its account is no longer stored.`,
          )
        }
      }
      // The record goes first: a deletion that happens before the record is
      // removed leaves a record pointing at a project that is gone, and every
      // later attempt to update or delete it fails in a way nobody can read.
      const removed = await state.removeRelay(input.id)
      if (!removed) return { removed: false, projectDeleted }
      if (account !== undefined) {
        try {
          await deleteVercelProject(
            {
              token: account.token,
              ...(account.teamId !== undefined ? { teamId: account.teamId } : {}),
            },
            relay.project,
          )
          projectDeleted = true
        } catch (err) {
          state.noteFailure(
            `The Vercel project of ${relay.name} could not be deleted: ${redact(describe(err), [account.token])}`,
          )
        }
      }
      announceChanged(announce, "relay removed")
      return { removed: true, projectDeleted }
    },

    /** Remove any exit, whichever kind it is. A Vercel project is left running. */
    removeExit: async (input) => {
      const exit = await state.removeExit(input.id)
      if (!exit) return { removed: false }
      announceChanged(announce, "exit removed")
      return { removed: true }
    },

    /** Redeploy the current relay code, keeping the URL and access token. */
    updateRelay: async (input, { error }) => {
      const relay = state.relay(input.id)
      if (!relay) {
        return error("update_failed", "Unknown relay.", {
          message: "This relay is not tracked any more.",
        })
      }
      const account = accountOf(state, relay)
      if (relay.project.length === 0) {
        // A relay this plugin did not deploy has no project to push code to,
        // so there is nothing to update. Saying "unknown account" would point
        // at the wrong thing: there never was an account.
        return error("update_failed", "This relay was not deployed by this plugin.", {
          message: "There is no Vercel project behind it, so there is nothing to redeploy.",
        })
      }
      if (!account) {
        return error("update_failed", "Unknown account.", {
          message: "The account this relay was deployed with is not there any more.",
        })
      }
      try {
        await deployToVercel({
          account: {
            token: account.token,
            ...(account.teamId !== undefined ? { teamId: account.teamId } : {}),
          },
          project: relay.project,
          region: relay.region,
          access: relay.access,
          // The same runtime the relay was deployed with: another one makes a
          // different relay, and it may stop answering.
          ...(relay.deployRuntime !== undefined ? { runtime: relay.deployRuntime } : {}),
          relaySource: relaySource(),
        })
      } catch (err) {
        return error("update_failed", "Vercel did not accept the deployment.", {
          message: redact(describe(err), [account.token, relay.access]),
        })
      }
      // Stamped when the probe starts: a live verdict while it is in flight
      // wins over whatever the probe answers.
      const checkedAt = Date.now()
      const healthEpoch = state.healthEpoch(relay.id)
      const probe = await probeRelay(relay.url, relay.access)
      await recordProbe(state, relay.id, probe, checkedAt, healthEpoch)
      announceChanged(announce, "relay updated")
      return { id: relay.id, reachable: probe.reachable }
    },

    /** Redeploy every relay this plugin deployed, with the current code. */
    updateAllRelays: async () => {
      let updated = 0
      const failed: Array<{ id: string; name: string; message: string }> = []
      // A relay that was not redeployed is reported, not dropped: the user
      // asked for every relay to be updated, and a silent skip would leave
      // one running the old code with nothing to say so.
      const skipped: Array<{ id: string; name: string; message: string }> = []
      for (const relay of state.relays()) {
        const account = accountOf(state, relay)
        if (relay.project.length === 0) {
          // A relay this plugin did not deploy was never an update target,
          // so it is not named here: the user did not ask for it to be
          // updated.
          continue
        }
        if (!account) {
          skipped.push({
            id: relay.id,
            name: relay.name,
            message: "The Vercel account this relay was deployed with is not stored any more.",
          })
          continue
        }
        try {
          await deployToVercel({
            account: {
              token: account.token,
              ...(account.teamId !== undefined ? { teamId: account.teamId } : {}),
            },
            project: relay.project,
            region: relay.region,
            access: relay.access,
            // The same runtime the relay was deployed with.
            ...(relay.deployRuntime !== undefined ? { runtime: relay.deployRuntime } : {}),
            relaySource: relaySource(),
          })
          // Stamped when the probe starts: a live verdict while it is in
          // flight wins over whatever the probe answers.
          const checkedAt = Date.now()
          const healthEpoch = state.healthEpoch(relay.id)
          const probe = await probeRelay(relay.url, relay.access)
          await recordProbe(state, relay.id, probe, checkedAt, healthEpoch)
          updated += 1
        } catch (err) {
          // A write that did not land is not a failed redeployment: the relay
          // may well be running the new code. The message says so, and the
          // relays that were updated keep their count: the user must not
          // redeploy them all.
          failed.push({
            id: relay.id,
            name: relay.name,
            message: redact(describe(err), [account.token, relay.access]),
          })
        }
      }
      // One announce for the whole batch, like deployRelays: per-relay
      // announcements would flood the conversation with refreshes.
      if (updated > 0) announceChanged(announce, "relays updated")
      return { updated, failed, skipped }
    },

    /** Test one exit: an OpenCode request, or a tiny real model request. */
    testExit: async (input) => {
      const result = await tester.test(input.id, input.deep ? "deep" : "api")
      announceChanged(announce, "exit tested")
      return {
        ok: result.ok,
        status: result.status,
        code: result.code,
        ms: result.ms,
        ...(result.egress !== undefined ? { egress: result.egress } : {}),
        ...(result.runtime !== undefined ? { runtime: result.runtime } : {}),
        ...(result.note !== undefined ? { note: result.note } : {}),
      }
    },

    /** Start checking every exit in the background. */
    testAll: async (input) => {
      const deep = input.deep === true
      const exits = state.exits()
      // A deep check carries the user's OpenCode session token, so it only
      // goes to the exits that are in use. The count is the one the scan will
      // really make, so the toast cannot promise checks that never run.
      const total = deep ? exits.filter((exit) => exit.enabled).length : exits.length
      if (total === 0 || state.scanning() !== undefined) {
        return { total, started: false }
      }
      void tester.scan(deep ? "deep" : "api").catch((error: unknown) => {
        state.noteFailure(`The exits could not be checked: ${describe(error)}`)
      })
      return { total, started: true }
    },

    /** Switch the exit the one-exit and until-exhausted strategies prefer. */
    useExit: async (input, { error }) => {
      // An id that is not there would be stored as the choice and would
      // replace a real one, and the answer would claim an exit was chosen
      // that does not exist.
      if (state.exit(input.id) === undefined) {
        return error("unknown_exit", "That exit is not there any more.", {
          message: "The exit was removed before it could be chosen.",
        })
      }
      await state.setActiveExit(input.id)
      announceChanged(announce, "active exit changed")
      return { active: input.id }
    },

    /** Pause an exit, or bring it back. */
    setExitEnabled: async (input, { error }) => {
      const current = state.exit(input.id)
      if (current === undefined) {
        return error("unknown_exit", "That exit is not there any more.", {
          message: "The exit was removed before it could be paused.",
        })
      }
      const changed = await state.setExitEnabled(input.id, input.enabled)
      if (changed) await announce(input.enabled ? "exit resumed" : "exit paused")
      // The answer says what the exit actually is now, not what was asked
      // for: an exit that was already paused stays paused, and saying
      // otherwise would be a small lie the next list would contradict.
      return { id: input.id, enabled: changed ? input.enabled : current.enabled }
    },

    /** Bring every paused exit back into use. */
    resumeAllExits: async () => {
      const resumed = await state.resumeAll()
      if (resumed.length > 0) announceChanged(announce, "exits resumed")
      return { resumed }
    },

    /** Add every proxy that can be read from a pasted list. */
    addProxies: async (input) => {
      // The cap counts bytes, not characters: the message says 512 KB, and a
      // list of non-Latin characters is two bytes each.
      if (Buffer.byteLength(input.text, "utf8") > 512 * 1024) {
        return {
          added: [],
          invalid: [
            {
              value: "",
              reason: "The list is larger than 512 KB. Add it in smaller parts.",
            },
          ],
          duplicates: 0,
        }
      }
      const parsed = parseProxyList(input.text)
      const existing = new Set(state.proxies().map((proxy) => proxyKey(proxy.url)))
      let duplicates = parsed.duplicates
      const records: ProxyRecord[] = []
      // A long list is checked one exit at a time afterwards, so a list of
      // tens of thousands would keep the plugin busy for hours, against
      // addresses the user pasted. The cap is reported, not applied silently.
      let overflow = 0
      for (const proxy of parsed.proxies) {
        if (existing.has(proxyKey(proxy.url))) {
          duplicates += 1
          continue
        }
        if (records.length >= IMPORT_PROXY_LIMIT) {
          overflow += 1
          continue
        }
        existing.add(proxyKey(proxy.url))
        records.push({
          kind: "proxy",
          id: randomUUID(),
          name: safeName(proxyName(proxy.host, proxy.port, records.length, input.name)),
          url: proxy.url,
          enabled: true,
          status: "untested",
          createdAt: Date.now(),
        })
      }
      await state.addProxyList(records)
      if (records.length > 0) {
        announceChanged(announce, "proxies added")
        // The list can be long, so the check runs behind the conversation. The
        // exits are usable as their checks finish.
        checkUntested()
      }
      return {
        added: records.map((proxy) => ({
          id: proxy.id,
          name: proxy.name,
          url: displayUrl(proxy.url),
          status: proxy.status,
        })),
        invalid: [...parsed.invalid],
        // The entries that were left out were valid, so they are not counted
        // among the ones that could not be read.
        ...(overflow > 0
          ? {
              leftOut: `${overflow} more prox${overflow === 1 ? "y was" : "ies were"} left out: a paste may add at most ${IMPORT_PROXY_LIMIT} proxies at a time.`,
            }
          : {}),
        duplicates,
      }
    },

    /** Change a proxy's name or address. A new address is tested afresh. */
    updateProxy: async (input) => {
      const current = state.proxy(input.id)
      if (!current) return { updated: false, reason: "This proxy is not there any more." }
      let url: string | undefined
      if (input.url !== undefined && input.url !== current.url) {
        const parsed = parseProxyUrl(input.url)
        if (!parsed) {
          // The parser's own reason is the one the user can act on: "the
          // credentials are masked" says what to do, where "could not be
          // read" does not.
          const reason = parseProxyList(input.url).invalid[0]?.reason
          return { updated: false, ...(reason !== undefined ? { reason } : {}) }
        }
        // The address is compared after the credentials are carried over: the
        // address the dialog shows has no credentials in it, and it rebuilds
        // the stored one exactly.
        const carried = keepCredentials(parsed, current.url)
        url = carried === current.url ? undefined : carried
      }
      // A name is cleaned like every other name: it comes from the terminal,
      // and a name that carries an escape sequence would be drawn in the
      // menu, in a toast and on a page. A name that cleans to nothing is not
      // a name.
      const cleaned = input.name !== undefined ? safeName(input.name) : undefined
      const name =
        cleaned !== undefined && cleaned.length > 0 && cleaned !== current.name
          ? cleaned
          : undefined
      // Nothing changed: there is nothing to write and nothing to announce.
      // The answer carries no reason: a reason means the change was refused,
      // and this one was simply not a change.
      if (name === undefined && url === undefined) {
        return { updated: false }
      }
      const next = await state.updateProxy(input.id, {
        ...(name !== undefined ? { name } : {}),
        ...(url !== undefined ? { url } : {}),
      })
      if (!next) return { updated: false, reason: "This proxy is not there any more." }
      announceChanged(announce, "proxy updated")
      if (url !== undefined) {
        void tester
          .test(next.id, "api")
          .then(() => announce("exit tested"))
          .catch((error: unknown) => {
            state.noteFailure(`The new address could not be checked: ${describe(error)}`)
          })
      }
      return { updated: true }
    },

    /** Turn routing on or off. */
    setEnabled: async (input) => {
      await state.setEnabled(input.enabled)
      await announce(input.enabled ? "routing enabled" : "routing disabled")
      return { enabled: input.enabled }
    },

    /** Choose which models are routed. Only free models are accepted. */
    setSelection: async (input) => {
      const list = await catalog.list()
      const models = input.models === undefined ? undefined : [...input.models]
      // When the price list could not be read, nothing can be verified. Keep
      // the ids rather than silently routing nothing, and say so in the note.
      let accepted = models
      let dropped: string[] = []
      if (models !== undefined && list.length > 0) {
        const free = new Set(list.filter(isFree).map((model) => model.id))
        accepted = models.filter((id) => free.has(id))
        dropped = models.filter((id) => !free.has(id))
      }
      const settings = await state.setSelection(input.selection, accepted)
      announceChanged(announce, "selection changed")
      return {
        selection: settings.selection,
        customModels: [...settings.customModels],
        dropped,
      }
    },

    /** Choose how the exits are used. */
    setStrategy: async (input) => {
      await state.setStrategy(input.strategy as Strategy)
      announceChanged(announce, "strategy changed")
      return { strategy: input.strategy }
    },

    /** Choose what happens when no exit can serve a request. */
    setDirect: async (input) => {
      await state.setDirect(input.direct as DirectPolicy)
      announceChanged(announce, "direct policy changed")
      return { direct: input.direct }
    },

    /** Whether the exits are checked in the background. */
    setHealthChecks: async (input) => {
      await state.setHealthChecks(input.enabled)
      announceChanged(announce, "health checks changed")
      return { enabled: input.enabled }
    },

    /** Bring the exits whose allowance is gone back into use. */
    resetExhausted: async () => {
      const restored = await state.restoreExhausted()
      announceChanged(announce, "exhausted exits restored")
      return { restored }
    },

    /** Show where the next request would go, without sending or advancing anything. */
    preview: async (input) => {
      const settings = state.settings()
      if (input.modelId !== undefined) {
        // The same decision the request hook takes, for the model that was
        // named. Without the provider the model belongs to, a model of another
        // provider that happens to share an id would be previewed as routed
        // when it never would be. The decision is asked even with routing off:
        // a named model brings a provider, and the provider is the reason it
        // would still go direct once routing is turned on.
        const decision = await decideModel(
          { state, catalog, bridgeReady: bridge.ready },
          {
            providerID: input.providerID ?? PROVIDER_ID,
            modelId: input.modelId,
            advance: false,
          },
        )
        const decided = decision.exit
        const exit = decided === undefined ? undefined : state.summaryOf(decided.id)
        // "Routing is off" is appended only when it is not already the whole
        // answer: for an opencode model decideModel says it itself, and
        // saying it twice would be noise.
        //
        // A model list that could not be read is the one case where the
        // request does not merely go direct: with direct forbidden, it is
        // refused, and the preview has to say so.
        const refused =
          !decision.routed &&
          settings.direct === "never" &&
          (decision.kind === "no-exit" || decision.kind === "bridge" || decision.kind === "catalog")
        const reason =
          decision.routed && decided !== undefined
            ? `The next request would go through ${decided.name}.`
            : refused && !decision.reason.includes("Direct routing is not allowed")
              ? `${decision.reason} Direct routing is not allowed.`
              : decision.kind === "off" || settings.enabled
                ? decision.reason
                : `${decision.reason} Routing is off, so the request goes straight to OpenCode.`
        return {
          modelId: input.modelId,
          ...(input.providerID !== undefined ? { providerID: input.providerID } : {}),
          routed: decision.routed,
          reason,
          direct: settings.direct,
          ...(exit !== undefined ? { exit } : {}),
          skipped: [...decision.skipped],
        }
      }
      // No model was named, so the provider cannot be judged. With routing off
      // nothing is routed, whatever the model, and the one answer covers all.
      if (!settings.enabled) {
        const pick = state.pickExit({ advance: false })
        return {
          ...(input.providerID !== undefined ? { providerID: input.providerID } : {}),
          routed: false,
          reason: "Routing is off: requests go straight to OpenCode.",
          direct: settings.direct,
          skipped: [...pick.skipped],
        }
      }
      // No model was named, so only the exit can be answered for. Claiming
      // that "the next request" goes through an exit would be a promise about
      // a request that has not been described yet: a paid model, a model
      // outside the chosen list and every other provider still go direct.
      // The routed count is checked here too, so the page agrees with the
      // pill when nothing survives the free-model filter.
      const list = selectModels(await catalog.list(), settings.selection, settings.customModels)
      const routedCount = list.filter((model) => model.routed).length
      if (routedCount === 0) {
        const pick = state.pickExit({ advance: false })
        const why =
          catalog.lastFailure() !== undefined
            ? "the model list could not be read"
            : settings.selection === "custom"
              ? "no chosen model is free"
              : "the provider lists no free model"
        return {
          ...(input.providerID !== undefined ? { providerID: input.providerID } : {}),
          routed: false,
          reason: `Nothing is routed right now (${why}), so the request goes straight to OpenCode.`,
          direct: settings.direct,
          skipped: [...pick.skipped],
        }
      }
      const pick = state.pickExit({ advance: false })
      const picked = pick.exit
      const exit = picked === undefined ? undefined : state.summaryOf(picked.id)
      const skipped = [...pick.skipped]
      if (exit === undefined) {
        return {
          ...(input.providerID !== undefined ? { providerID: input.providerID } : {}),
          routed: false,
          reason:
            settings.direct === "never"
              ? `${pick.reason} The plugin is set to never go direct, so the request fails.`
              : `${pick.reason} The request goes direct.`,
          direct: settings.direct,
          skipped,
        }
      }
      if (exit.kind === "proxy" && !bridge.ready) {
        // The bridge stops the proxies, not the relays: another exit may still
        // carry the request, and the preview has to say where.
        const withoutProxies = state.pickExit({ advance: false, exclude: proxyExclusions(state) })
        if (withoutProxies.exit !== undefined) {
          const other = state.summaryOf(withoutProxies.exit.id)
          return {
            ...(input.providerID !== undefined ? { providerID: input.providerID } : {}),
            routed: true,
            reason: `The request would go through ${withoutProxies.exit.name}.`,
            direct: settings.direct,
            ...(other !== undefined ? { exit: other } : {}),
            skipped: [...withoutProxies.skipped],
          }
        }
        return {
          ...(input.providerID !== undefined ? { providerID: input.providerID } : {}),
          routed: false,
          reason: `The local proxy bridge is not running, so ${exit.name} cannot carry the request.`,
          direct: settings.direct,
          exit,
          skipped,
        }
      }
      return {
        ...(input.providerID !== undefined ? { providerID: input.providerID } : {}),
        routed: true,
        reason: `A free ${PROVIDER_ID} model would go through ${exit.name}. Paid models, models outside your chosen list, and other providers go direct.`,
        direct: settings.direct,
        exit,
        skipped,
      }
    },

    /** Write the exits and the rules out as JSON. Credentials are included. */
    exportConfig: async () => {
      const settings = state.settings()
      const payload = {
        version: 1,
        exportedAt: Date.now(),
        relays: state.relays().map((relay) => ({
          name: relay.name,
          url: relay.url,
          access: relay.access,
          region: relay.region,
          project: relay.project,
        })),
        proxies: state.proxies().map((proxy) => ({
          name: proxy.name,
          url: proxy.url,
        })),
        settings: {
          selection: settings.selection,
          strategy: settings.strategy,
          direct: settings.direct,
          customModels: [...settings.customModels],
          healthChecks: settings.healthChecks,
        },
      }
      return { json: JSON.stringify(payload, null, 2) }
    },

    /** Read exits and rules back in. Accounts are never imported. */
    importConfig: async (input) => {
      // The cap is bytes, not UTF-16 code units: the message says "2 MB", and a
      // page of non-Latin text is more bytes than characters.
      if (Buffer.byteLength(input.json, "utf8") > IMPORT_LIMIT_BYTES) {
        const reason = "The configuration is larger than 2 MB, so nothing was imported."
        state.noteFailure(reason)
        return { relays: 0, proxies: 0, invalid: 0, error: reason }
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(input.json)
      } catch {
        // The file could not be read at all, so no entry was left out: saying
        // "one entry" would send the user hunting for a bad entry in a file
        // that was never parsed.
        return {
          relays: 0,
          proxies: 0,
          invalid: 0,
          error: "This is not valid JSON, so nothing was imported.",
        }
      }
      if (!parsed || typeof parsed !== "object") {
        return {
          relays: 0,
          proxies: 0,
          invalid: 0,
          error: "This is not a relay configuration, so nothing was imported.",
        }
      }
      const record = parsed as Record<string, unknown>
      let invalid = 0
      let relays = 0
      let proxies = 0
      let duplicates = 0
      // The entries that were left out because there were too many of them:
      // they are valid, so they are not counted as invalid entries, and the
      // reason says what happened to them.
      let overflow = 0
      const importedRelays: RelayRecord[] = []

      const relayEntries = Array.isArray(record["relays"]) ? record["relays"] : []
      // Importing the same export twice must not duplicate anything: a relay
      // is the same one when its address and access token match, a proxy when
      // its URL matches (credentials included, case-sensitively). Duplicates
      // are skipped silently; the counts say how many exits were added.
      const seenRelays = new Set(
        state.relays().map((relay) => JSON.stringify([relay.url, relay.access])),
      )
      for (const entry of relayEntries) {
        if (!entry || typeof entry !== "object") {
          invalid += 1
          continue
        }
        const relay = entry as Record<string, unknown>
        const name = relay["name"]
        const url = relay["url"]
        const access = relay["access"]
        if (typeof name !== "string" || typeof url !== "string" || typeof access !== "string") {
          invalid += 1
          continue
        }
        const normalized = normalizeRelayUrl(url.trim())
        if (!isSafeRelayUrl(normalized)) {
          invalid += 1
          continue
        }
        // Credentials in the address would be stored, shown and exported in
        // the clear, so an address that carries them is refused. An address
        // that cannot be parsed is refused too, rather than crashing the
        // import and losing every entry after it.
        const parsedAddress = parseRelayAddress(normalized)
        if (parsedAddress === undefined || parsedAddress.username.length > 0 || parsedAddress.password.length > 0) {
          invalid += 1
          continue
        }
        // The cap is applied to entries that have passed every check: only a
        // valid entry is counted as left out, so "invalid" stays what it says.
        if (importedRelays.length >= IMPORT_RELAY_LIMIT) {
          overflow += 1
          continue
        }
        const stored = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized
        const identity = JSON.stringify([stored, access])
        if (seenRelays.has(identity)) {
          duplicates += 1
          continue
        }
        seenRelays.add(identity)
        importedRelays.push({
          kind: "relay",
          id: randomUUID(),
          name: safeName(name),
          // An imported relay is tracked only: accounts are never imported, so
          // the exported project name has no account behind it here. Keeping
          // it would offer Update and Delete-project actions that always fail.
          project: "",
          region: typeof relay["region"] === "string" ? relay["region"] : "",
          url: stored,
          access,
          accountId: "",
          enabled: true,
          status: "untested",
          createdAt: Date.now(),
        })
        relays += 1
      }

      const proxyEntries = Array.isArray(record["proxies"]) ? record["proxies"] : []
      const seenProxies = new Set(state.proxies().map((proxy) => proxyKey(proxy.url)))
      const imported: ProxyRecord[] = []
      for (const entry of proxyEntries) {
        const url = typeof entry === "string"
          ? entry
          : entry && typeof entry === "object"
            ? (entry as Record<string, unknown>)["url"]
            : undefined
        if (typeof url !== "string") {
          invalid += 1
          continue
        }
        const proxy = parseProxyUrl(url)
        if (!proxy) {
          invalid += 1
          continue
        }
        // The cap is applied to entries that have passed every check, and
        // after the duplicate check: only a valid entry is counted as left
        // out, so "invalid" stays what it says.
        const key = proxyKey(proxy.url)
        if (seenProxies.has(key)) {
          duplicates += 1
          continue
        }
        if (imported.length >= IMPORT_PROXY_LIMIT) {
          overflow += 1
          continue
        }
        seenProxies.add(key)
        const wanted =
          entry && typeof entry === "object"
            ? (entry as Record<string, unknown>)["name"]
            : undefined
        imported.push({
          kind: "proxy",
          id: randomUUID(),
          name: safeName(typeof wanted === "string" && wanted.length > 0 ? wanted : `${proxy.host}:${proxy.port}`),
          url: proxy.url,
          enabled: true,
          status: "untested",
          createdAt: Date.now(),
        })
        proxies += 1
      }
      const relaysBefore = state.relays().length
      const proxiesBefore = state.proxies().length
      try {
        await state.addRelayList(importedRelays)
        await state.addProxyList(imported)

        const rules = record["settings"]
        if (rules && typeof rules === "object") {
          const settings = rules as Record<string, unknown>
          const selection = settings["selection"]
          const strategy = settings["strategy"]
          const direct = settings["direct"]
          const healthChecks = settings["healthChecks"]
          // The rules go in with one write: four writes could fail halfway and
          // leave a mixture of the old settings and the new ones.
          await state.applySettings({
            ...(selection === "free" || selection === "custom"
              ? {
                  selection: selection as Selection,
                  customModels: Array.isArray(settings["customModels"])
                    ? settings["customModels"].filter((id): id is string => typeof id === "string")
                    : [...state.settings().customModels],
                }
              : {}),
            ...(strategy === "fixed" ||
            strategy === "round-robin" ||
            strategy === "exhausted" ||
            strategy === "fastest"
              ? { strategy: strategy as Strategy }
              : {}),
            ...(direct === "allow" || direct === "never" ? { direct: direct as DirectPolicy } : {}),
            ...(typeof healthChecks === "boolean" ? { healthChecks } : {}),
          })
        }
      } catch (error) {
        if (!(error instanceof StorageError)) throw error
        // The import stopped partway. What landed is what the state holds, and
        // the user is told it stopped rather than being answered as if the
        // whole file had gone in.
        const reason = `The import stopped partway: ${error.message}`
        state.noteFailure(reason)
        return {
          relays: state.relays().length - relaysBefore,
          proxies: state.proxies().length - proxiesBefore,
          invalid,
          error: reason,
        }
      }
      announceChanged(announce, "configuration imported")
      // Imported exits stay untested on purpose: a deep test sends the
      // user's own OpenCode session token through the exit, and a shared or
      // tampered config must not be able to aim that at a URL of its choosing.
      // The user tests an imported exit explicitly. The duplicate count is
      // only reported when there was one, so a plain import answer stays
      // exactly what it always was.
      const leftOut =
        overflow > 0
          ? `${overflow} more entr${overflow === 1 ? "y was" : "ies were"} left out: an import may add at most ${IMPORT_RELAY_LIMIT} relays and ${IMPORT_PROXY_LIMIT} proxies at a time.`
          : undefined
      return {
        relays,
        proxies,
        invalid,
        ...(leftOut !== undefined ? { leftOut } : {}),
        ...(duplicates > 0 ? { duplicates } : {}),
      }
    },  })
}

/**
 * Report a failed write to the caller.
 *
 * A change that could not be saved must not look like a change that was: the
 * caller is told which list could not be written, so it can say so instead of
 * reporting a success that the next restart would undo. Every handler goes
 * through here, so no mutator can answer "done" for a write that failed.
 */
function reportStorageFailures(handlers: RpcHandlers<typeof Relay>): RpcHandlers<typeof Relay> {
  const wrapped: Record<string, unknown> = {}
  for (const [name, handler] of Object.entries(handlers)) {
    wrapped[name] = async (input: unknown, context: { readonly error: unknown }) => {
      try {
        return await (handler as (i: unknown, c: unknown) => Promise<unknown>)(input, context)
      } catch (error) {
        if (!(error instanceof StorageError)) throw error
        const fail = context.error as (
          type: string,
          message: string,
          data?: { readonly message: string },
        ) => unknown
        // The reason goes in the message itself: the toast the user reads
        // shows the message, so a cause kept only in the data would never be
        // seen.
        return fail("storage_failed", `Could not save the change: ${error.message}`, {
          message: error.message,
        })
      }
    }
  }
  return wrapped as RpcHandlers<typeof Relay>
}
