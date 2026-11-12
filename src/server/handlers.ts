/**
 * The RPC the terminal part talks to.
 *
 * Every handler here is one the contract in src/rpc.ts declares. The handlers
 * own no state of their own: they read and write the state object they are
 * given, and every change is announced so the terminal part can refresh.
 */
import { randomBytes, randomUUID } from "node:crypto"
import type { RpcHandlers } from "@opencode/plugin/promise/rpc"
import { Relay } from "../rpc.ts"
import {
  regionLabel,
  toAccountSummary,
  toRelaySummary,
  type AccountPlan,
  type RelayRecord,
} from "../lib/types.ts"
import { selectModels } from "../lib/routing.ts"
import { redact } from "../lib/redact.ts"
import {
  deleteVercelProject,
  deployRelay as deployToVercel,
  inspectVercel,
  probeRelay,
  type DeployRelayResult,
} from "../lib/vercel.ts"
import { projectName, relaySource } from "../lib/relay-source.ts"
import type { ModelCatalog } from "./models.ts"
import type { RelayState, Settings } from "./state.ts"

/** Everything the handlers need from the outside world. */
export interface HandlerDeps {
  readonly state: RelayState
  readonly catalog: ModelCatalog
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

/** A sentence for the user, saying what the plugin is doing right now. */
function describeState(
  settings: Settings,
  active: RelayRecord | undefined,
  routed: number,
  total: number,
  catalog: ModelCatalog,
  notes: readonly string[],
): string {
  if (!settings.enabled) return "Routing is off: requests go straight to OpenCode."
  if (!active) return "Routing is on, but no relay is chosen."
  const place = regionLabel(active.region)
  const where = place.length > 0 ? ` in ${place}` : ""
  const models =
    total === 0
      ? "no model is routed"
      : `${routed} of ${total} OpenCode models are routed`
  const problems: string[] = []
  const failure = catalog.lastFailure()
  if (failure) {
    // A list that could not be read is not an empty list, and saying so keeps the
    // user from believing nothing is routed when in fact nothing is known.
    problems.push("The model list could not be read, so no model is known to be free.")
  }
  problems.push(...notes)
  const note = `Routing ${models} through ${active.name}${where}.`
  return problems.length === 0 ? note : `${note} ${problems.join(" ")}`
}

/** The handlers of the relay contract. */
export function createHandlers(deps: HandlerDeps): RpcHandlers<typeof Relay> {
  const { state, catalog, announce } = deps

  return {
    /** What the plugin is doing right now: on or off, through which relay, and what it knows. */
    status: async () => {
      const settings = state.settings()
      const active = state.activeRelay()
      const list = selectModels(
        await catalog.list(),
        settings.selection,
        settings.customModels,
      )
      const routed = list.filter((model) => model.routed).length
      return {
        enabled: settings.enabled,
        selection: settings.selection,
        customModels: [...settings.customModels],
        ...(active ? { activeRelay: toRelaySummary(active) } : {}),
        relays: state.relays().map((relay) => toRelaySummary(relay)),
        accounts: state.accounts().map((account) => toAccountSummary(account)),
        note: describeState(settings, active, routed, list.length, catalog, state.notes()),
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
        projects: plan.projects,
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
      const access = newAccessToken()
      const project = projectName({ region: input.region, suffix: projectSuffix(input.name) })
      let deployed: DeployRelayResult
      try {
        deployed = await deployToVercel({
          account: {
            token: account.token,
            ...(account.teamId !== undefined ? { teamId: account.teamId } : {}),
          },
          project,
          region: input.region,
          ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
          access,
          relaySource: relaySource(),
        })
      } catch (err) {
        return error("deploy_failed", "Vercel did not accept the deployment.", {
          message: redact(describe(err), [account.token, access]),
        })
      }
      const relay: RelayRecord = {
        id: randomUUID(),
        name: input.name ?? `Relay in ${regionLabel(input.region)}`,
        project: deployed.project,
        region: deployed.region,
        url: deployed.url,
        access,
        accountId: account.id,
        status: "unknown",
        createdAt: Date.now(),
      }
      await state.addRelay(relay)
      const probe = await probeRelay(relay.url, relay.access)
      await state.setRelayStatus(relay.id, probe.reachable ? "ready" : "unreachable")
      await announce("relay deployed")
      return {
        id: relay.id,
        name: relay.name,
        url: relay.url,
        region: relay.region,
        regionLabel: regionLabel(relay.region),
        reachable: probe.reachable,
      }
    },

    /** Track a relay that already exists somewhere else. */
    addRelay: async (input) => {
      const region = input.region ?? ""
      const relay: RelayRecord = {
        id: randomUUID(),
        name: input.name,
        // A relay that was brought here was not deployed by this plugin, so it has
        // no project of its own and no account behind it.
        project: "",
        region,
        url: input.url,
        access: input.access,
        accountId: "",
        status: "unknown",
        createdAt: Date.now(),
      }
      await state.addRelay(relay)
      const probe = await probeRelay(relay.url, relay.access)
      await state.setRelayStatus(relay.id, probe.reachable ? "ready" : "unreachable")
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
      if (!relay) return { removed: false }
      if (input.deleteProject) {
        const account = state.account(relay.accountId)
        if (account && relay.project.length > 0) {
          try {
            await deleteVercelProject(
              {
                token: account.token,
                ...(account.teamId !== undefined ? { teamId: account.teamId } : {}),
              },
              relay.project,
            )
          } catch (err) {
            // The relay is gone either way, and a project left behind in the
            // dashboard is a smaller problem than a failed removal. The user is
            // told, because a project they asked to delete is still running.
            state.noteFailure(
              `The Vercel project of ${relay.name} could not be deleted: ${redact(describe(err), [account.token])}`,
            )
          }
        }
      }
      await state.removeRelay(input.id)
      await announce("relay removed")
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
      const account = state.account(relay.accountId)
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
      await state.setRelayStatus(relay.id, probe.reachable ? "ready" : "unreachable")
      await announce("relay updated")
      return { id: relay.id, reachable: probe.reachable }
    },

    /** Ask a relay whether it answers, and which address it sends from. */
    testRelay: async (input) => {
      const relay = state.relay(input.id)
      if (!relay) return { reachable: false, status: 0 }
      const probe = await probeRelay(relay.url, relay.access)
      const changed = await state.setRelayStatus(relay.id, probe.reachable ? "ready" : "unreachable")
      if (changed) await announce("relay status changed")
      return {
        reachable: probe.reachable,
        status: probe.status,
        ...(probe.egress !== undefined ? { egress: probe.egress } : {}),
        ...(probe.runtime !== undefined ? { runtime: probe.runtime } : {}),
      }
    },

    /** Switch the active relay. */
    useRelay: async (input) => {
      await state.setActiveRelay(input.id)
      await announce("active relay changed")
      return { active: input.id }
    },

    /** Turn routing on or off. */
    setEnabled: async (input) => {
      await state.setEnabled(input.enabled)
      await announce(input.enabled ? "routing enabled" : "routing disabled")
      return { enabled: input.enabled }
    },

    /** Choose which models are routed. */
    setSelection: async (input) => {
      const settings = await state.setSelection(input.selection, input.models)
      await announce("selection changed")
      return { selection: settings.selection, customModels: [...settings.customModels] }
    },
  }
}