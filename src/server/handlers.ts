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
import { isFree, selectModels } from "../lib/routing.ts"
import { parseProxyList, parseProxyUrl } from "../lib/proxy.ts"
import { redact } from "../lib/redact.ts"
import {
  deleteVercelProject,
  deployRelay as deployToVercel,
  inspectVercel,
  probeRelay,
} from "../lib/vercel.ts"
import { projectName, relaySource } from "../lib/relay-source.ts"
import type { ModelCatalog } from "./models.ts"
import type { RelayState, Settings } from "./state.ts"
import type { Tester } from "./tester.ts"

/** Everything the handlers need from the outside world. */
export interface HandlerDeps {
  readonly state: RelayState
  readonly catalog: ModelCatalog
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

/** The access token a relay requires. It is a secret, so it is not guessable. */
function newAccessToken(): string {
  return randomBytes(24).toString("hex")
}

/** A proxy's default name: its address, which is what the user recognizes. */
function proxyName(host: string, port: number, index: number, prefix?: string): string {
  const address = `${host}:${port}`
  return prefix !== undefined && prefix.length > 0 ? `${prefix} ${index + 1}` : address
}

/** A Vercel account behind a relay, when it is still stored. */
function accountOf(state: RelayState, relay: RelayRecord): Account | undefined {
  return relay.accountId.length > 0 ? state.account(relay.accountId) : undefined
}

/** A sentence for the user, saying what the plugin is doing right now. */
function describeState(options: {
  readonly settings: Settings
  readonly exits: readonly ExitSummary[]
  readonly active: ExitSummary | undefined
  readonly routed: number
  readonly modelCount: number
  readonly catalog: ModelCatalog
  readonly notes: readonly string[]
  readonly exhausted: readonly string[]
  readonly skipped: readonly string[]
}): string {
  const { settings, exits, active, routed, modelCount, catalog, notes, exhausted, skipped } = options
  if (!settings.enabled) return "Routing is off: requests go straight to OpenCode."
  if (exits.length === 0) return "Routing is on, but there is no relay or proxy yet."

  const usable = exits.filter(
    (exit) =>
      exit.enabled &&
      !exhausted.includes(exit.id) &&
      !skipped.includes(exit.id) &&
      exit.status !== "unreachable" &&
      exit.status !== "blocked" &&
      exit.status !== "bad",
  ).length

  const models = modelCount === 0 ? "no model" : `${routed} free model${routed === 1 ? "" : "s"}`
  const problems: string[] = []
  if (catalog.lastFailure()) {
    problems.push("The model list could not be read, so no model is known to be free.")
  }
  if (exhausted.length > 0) {
    problems.push(`${exhausted.length} exit${exhausted.length === 1 ? " is" : "s are"} used up.`)
  }
  const otherSkipped = skipped.filter((id) => id !== active?.id)
  if (otherSkipped.length > 0) {
    const names = otherSkipped
      .map((id) => exits.find((exit) => exit.id === id)?.name)
      .filter((name): name is string => name !== undefined)
    if (names.length > 0) {
      problems.push(
        names.length === 1
          ? `${names[0]} did not answer, so it is skipped.`
          : `${names.join(", ")} did not answer, so they are skipped.`,
      )
    }
  }
  problems.push(...notes)

  if (usable === 0) {
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
        : active !== undefined
          ? `through ${active.name}`
          : "through the exits"
  const activeSkipped = active !== undefined && skipped.includes(active.id)
  const note = activeSkipped
    ? `${active.name} did not answer, so the next usable exit takes over.`
    : `Routing ${models} ${where} (${settings.strategy === "exhausted" ? "until it is exhausted" : settings.strategy}).`
  return problems.length === 0 ? note : `${note} ${problems.join(" ")}`
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
    enabled: true,
    status: "untested",
    createdAt: Date.now(),
  }
  await state.addRelay(relay)
  const probe = await probeRelay(relay.url, relay.access)
  await state.setHealth(relay.id, {
    status: probe.reachable ? "reachable" : "unreachable",
    latencyMs: probe.ms,
    ...(probe.egress !== undefined ? { egress: probe.egress } : {}),
    ...(probe.runtime !== undefined ? { runtime: probe.runtime } : {}),
    ...(probe.reachable ? {} : { lastError: "The relay did not answer its first check." }),
  })
  return {
    id: relay.id,
    name: relay.name,
    url: relay.url,
    region: relay.region,
    regionLabel: regionLabel(relay.region),
    reachable: probe.reachable,
  }
}

/** The handlers of the relay contract. */
export function createHandlers(deps: HandlerDeps): RpcHandlers<typeof Relay> {
  const { state, catalog, tester, announce } = deps

  /** Check whatever is still untested after a list was imported or added. */
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

  return {
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
      const active = state.activeExit()
      const activeSummary = active === undefined ? undefined : state.summaryOf(active.id)
      const paused = exits.filter((exit) => !exit.enabled).map((exit) => exit.id)
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
        ...(state.scanning() !== undefined ? { scanning: state.scanning() } : {}),
        ...(state.lastDecision() !== undefined ? { lastDecision: state.lastDecision() } : {}),
        note: describeState({
          settings,
          exits,
          active: activeSummary,
          routed,
          modelCount: list.length,
          catalog,
          notes: state.notes(),
          exhausted,
          skipped,
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
      let plan: AccountPlan
      try {
        plan = await inspectVercel({
          token: input.token,
          ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
        })
      } catch (err) {
        return error("invalid_token", "Vercel did not accept this token.", {
          message: redact(describe(err), [input.token]),
        })
      }
      const account = await state.addAccount({
        name: input.name,
        token: input.token,
        ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
        plan: plan.plan,
      })
      await announce("account added")
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
      if (removed) await announce("account removed")
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
          name: input.name,
          runtime: input.runtime,
        })
        await announce("relay deployed")
        return deployed
      } catch (err) {
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
      for (const region of input.regions) {
        try {
          deployed.push(
            await deployOne({
              state,
              account,
              region,
              name: input.name,
              runtime: input.runtime,
            }),
          )
        } catch (err) {
          failed.push({
            region,
            message: redact(describe(err), [account.token]),
          })
        }
      }
      if (deployed.length > 0) await announce("relays deployed")
      return { deployed, failed }
    },

    /** Track a relay that already exists somewhere else. */
    addRelay: async (input) => {
      const url = input.url.startsWith("http") ? input.url : `https://${input.url}`
      const relay: RelayRecord = {
        kind: "relay",
        id: randomUUID(),
        name: input.name,
        // A relay that was brought here was not deployed by this plugin, so it
        // has no project of its own and no account behind it.
        project: "",
        region: input.region ?? "",
        url: url.endsWith("/") ? url.slice(0, -1) : url,
        access: input.access,
        accountId: "",
        enabled: true,
        status: "untested",
        createdAt: Date.now(),
      }
      await state.addRelay(relay)
      const probe = await probeRelay(relay.url, relay.access)
      await state.setHealth(relay.id, {
        status: probe.reachable ? "reachable" : "unreachable",
        latencyMs: probe.ms,
        ...(probe.egress !== undefined ? { egress: probe.egress } : {}),
        ...(probe.runtime !== undefined ? { runtime: probe.runtime } : {}),
        ...(probe.reachable ? {} : { lastError: "The relay did not answer its first check." }),
      })
      await announce("relay added")
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
      if (input.deleteProject && relay.project.length > 0) {
        const account = accountOf(state, relay)
        if (!account) {
          // A tracked relay has no account, and a deployed relay whose account
          // was removed can no longer be deleted from here. Saying so is better
          // than a success message about a project that is still running.
          state.noteFailure(
            `The Vercel project of ${relay.name} was not deleted: its account is no longer stored.`,
          )
        } else {
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
      }
      await state.removeRelay(input.id)
      await announce("relay removed")
      return { removed: true, projectDeleted }
    },

    /** Remove any exit, whichever kind it is. A Vercel project is left running. */
    removeExit: async (input) => {
      const exit = await state.removeExit(input.id)
      if (!exit) return { removed: false }
      await announce("exit removed")
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
          relaySource: relaySource(),
        })
      } catch (err) {
        return error("update_failed", "Vercel did not accept the deployment.", {
          message: redact(describe(err), [account.token, relay.access]),
        })
      }
      const probe = await probeRelay(relay.url, relay.access)
      await state.setHealth(relay.id, {
        status: probe.reachable ? "reachable" : "unreachable",
        latencyMs: probe.ms,
        ...(probe.egress !== undefined ? { egress: probe.egress } : {}),
        ...(probe.runtime !== undefined ? { runtime: probe.runtime } : {}),
      })
      await announce("relay updated")
      return { id: relay.id, reachable: probe.reachable }
    },

    /** Redeploy every relay this plugin deployed, with the current code. */
    updateAllRelays: async () => {
      let updated = 0
      const failed: Array<{ id: string; name: string; message: string }> = []
      for (const relay of state.relays()) {
        const account = accountOf(state, relay)
        if (relay.project.length === 0 || !account) continue
        try {
          await deployToVercel({
            account: {
              token: account.token,
              ...(account.teamId !== undefined ? { teamId: account.teamId } : {}),
            },
            project: relay.project,
            region: relay.region,
            access: relay.access,
            relaySource: relaySource(),
          })
          const probe = await probeRelay(relay.url, relay.access)
          await state.setHealth(relay.id, {
            status: probe.reachable ? "reachable" : "unreachable",
            latencyMs: probe.ms,
          })
          updated += 1
        } catch (err) {
          failed.push({
            id: relay.id,
            name: relay.name,
            message: redact(describe(err), [account.token, relay.access]),
          })
        }
        await announce("relays updated")
      }
      return { updated, failed }
    },

    /** Test one exit: an OpenCode request, or a tiny real model request. */
    testExit: async (input) => {
      const result = await tester.test(input.id, input.deep ? "deep" : "api")
      await announce("exit tested")
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
      const total = state.exits().length
      if (total === 0 || state.scanning() !== undefined) {
        return { total, started: false }
      }
      void tester.scan(input.deep ? "deep" : "api").catch((error: unknown) => {
        state.noteFailure(`The exits could not be checked: ${describe(error)}`)
      })
      return { total, started: true }
    },

    /** Switch the exit the one-exit and until-exhausted strategies prefer. */
    useExit: async (input) => {
      await state.setActiveExit(input.id)
      await announce("active exit changed")
      return { active: input.id }
    },

    /** Pause an exit, or bring it back. */
    setExitEnabled: async (input) => {
      const changed = await state.setExitEnabled(input.id, input.enabled)
      if (changed) await announce(input.enabled ? "exit resumed" : "exit paused")
      return { id: input.id, enabled: input.enabled }
    },

    /** Add every proxy that can be read from a pasted list. */
    addProxies: async (input) => {
      if (input.text.length > 512 * 1024) {
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
      const existing = new Set(state.proxies().map((proxy) => proxy.url.toLowerCase()))
      let duplicates = parsed.duplicates
      const records: ProxyRecord[] = []
      for (const proxy of parsed.proxies) {
        if (existing.has(proxy.url.toLowerCase())) {
          duplicates += 1
          continue
        }
        existing.add(proxy.url.toLowerCase())
        records.push({
          kind: "proxy",
          id: randomUUID(),
          name: proxyName(proxy.host, proxy.port, records.length, input.name),
          url: proxy.url,
          enabled: true,
          status: "untested",
          createdAt: Date.now(),
        })
      }
      await state.addProxyList(records)
      if (records.length > 0) {
        await announce("proxies added")
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
        duplicates,
      }
    },

    /** Change a proxy's name or address. A new address is tested afresh. */
    updateProxy: async (input) => {
      const current = state.proxy(input.id)
      if (!current) return { updated: false }
      let url: string | undefined
      if (input.url !== undefined && input.url !== current.url) {
        const parsed = parseProxyUrl(input.url)
        if (!parsed) return { updated: false }
        url = parsed.url
      }
      const next = await state.updateProxy(input.id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(url !== undefined ? { url } : {}),
      })
      if (!next) return { updated: false }
      await announce("proxy updated")
      if (url !== undefined) {
        void tester.test(next.id, "api").then(() => announce("exit tested")).catch(() => {})
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
      await announce("selection changed")
      return {
        selection: settings.selection,
        customModels: [...settings.customModels],
        dropped,
      }
    },

    /** Choose how the exits are used. */
    setStrategy: async (input) => {
      await state.setStrategy(input.strategy as Strategy)
      await announce("strategy changed")
      return { strategy: input.strategy }
    },

    /** Choose what happens when no exit can serve a request. */
    setDirect: async (input) => {
      await state.setDirect(input.direct as DirectPolicy)
      await announce("direct policy changed")
      return { direct: input.direct }
    },

    /** Whether the exits are checked in the background. */
    setHealthChecks: async (input) => {
      await state.setHealthChecks(input.enabled)
      await announce("health checks changed")
      return { enabled: input.enabled }
    },

    /** Bring the exits whose allowance is gone back into use. */
    resetExhausted: async () => {
      const restored = await state.restoreExhausted()
      await announce("exhausted exits restored")
      return { restored }
    },

    /** Show where the next request would go, without sending or advancing anything. */
    preview: async (input) => {
      const settings = state.settings()
      const pick = state.pickExit({ advance: false })
      const exit = pick.exit === undefined ? undefined : state.summaryOf(pick.exit.id)
      const skipped = [...pick.skipped]
      if (!settings.enabled) {
        return {
          ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
          routed: false,
          reason: "Routing is off: requests go straight to OpenCode.",
          direct: settings.direct,
          skipped,
        }
      }
      if (input.modelId !== undefined) {
        const list = await catalog.list()
        const model = catalog.resolve(list, input.modelId, settings.selection)
        if (!isFree(model)) {
          return {
            modelId: input.modelId,
            routed: false,
            reason: `${model.name} is not free, so the plugin never routes it.`,
            direct: settings.direct,
            skipped,
          }
        }
        if (settings.selection === "custom" && !settings.customModels.includes(model.id)) {
          return {
            modelId: input.modelId,
            routed: false,
            reason: `${model.name} is not in the chosen list.`,
            direct: settings.direct,
            skipped,
          }
        }
      }
      if (exit === undefined) {
        return {
          ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
          routed: false,
          reason:
            settings.direct === "never"
              ? `${pick.reason} The plugin is set to never go direct, so the request fails.`
              : `${pick.reason} The request goes direct.`,
          direct: settings.direct,
          ...(exit !== undefined ? { exit } : {}),
          skipped,
        }
      }
      return {
        ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
        routed: true,
        reason: `The next request goes through ${exit.name}.`,
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
      let parsed: unknown
      try {
        parsed = JSON.parse(input.json)
      } catch {
        return { relays: 0, proxies: 0, invalid: 1 }
      }
      if (!parsed || typeof parsed !== "object") return { relays: 0, proxies: 0, invalid: 1 }
      const record = parsed as Record<string, unknown>
      let invalid = 0
      let relays = 0
      let proxies = 0

      const relayEntries = Array.isArray(record["relays"]) ? record["relays"] : []
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
        const normalized = url.startsWith("http") ? url : `https://${url}`
        await state.addRelay({
          kind: "relay",
          id: randomUUID(),
          name,
          project: typeof relay["project"] === "string" ? relay["project"] : "",
          region: typeof relay["region"] === "string" ? relay["region"] : "",
          url: normalized.endsWith("/") ? normalized.slice(0, -1) : normalized,
          access,
          accountId: "",
          enabled: true,
          status: "untested",
          createdAt: Date.now(),
        })
        relays += 1
      }

      const proxyEntries = Array.isArray(record["proxies"]) ? record["proxies"] : []
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
        const wanted =
          entry && typeof entry === "object"
            ? (entry as Record<string, unknown>)["name"]
            : undefined
        imported.push({
          kind: "proxy",
          id: randomUUID(),
          name: typeof wanted === "string" && wanted.length > 0 ? wanted : `${proxy.host}:${proxy.port}`,
          url: proxy.url,
          enabled: true,
          status: "untested",
          createdAt: Date.now(),
        })
        proxies += 1
      }
      await state.addProxyList(imported)

      const rules = record["settings"]
      if (rules && typeof rules === "object") {
        const settings = rules as Record<string, unknown>
        const selection = settings["selection"]
        if (selection === "free" || selection === "custom") {
          const models = Array.isArray(settings["customModels"])
            ? settings["customModels"].filter((id): id is string => typeof id === "string")
            : undefined
          await state.setSelection(selection as Selection, models)
        }
        const strategy = settings["strategy"]
        if (strategy === "fixed" || strategy === "round-robin" || strategy === "exhausted" || strategy === "fastest") {
          await state.setStrategy(strategy)
        }
        const direct = settings["direct"]
        if (direct === "allow" || direct === "never") await state.setDirect(direct)
        if (typeof settings["healthChecks"] === "boolean") {
          await state.setHealthChecks(settings["healthChecks"])
        }
      }
      await announce("configuration imported")
      if (relays > 0 || proxies > 0) checkUntested()
      return { relays, proxies, invalid }
    },
  }
}
