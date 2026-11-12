/**
 * The plugin's server half: the hooks that route traffic, and the RPC the TUI talks to.
 *
 * The hooks are the only place where the plugin changes what OpenCode sends, and
 * they are deliberately narrow: only the OpenCode provider's own requests are
 * touched, and only when the plugin is on, a relay is picked and the model is
 * selected. Everything else is left exactly as it was, so a plugin with no
 * accounts and no relays changes nothing at all.
 */
import { randomBytes, randomUUID } from "node:crypto"
import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { RpcHandlers } from "@opencode/plugin/promise/rpc"
import { Relay } from "../rpc.ts"
import {
  PROVIDER_ID,
  regionLabel,
  toAccountSummary,
  toRelaySummary,
  type AccountPlan,
  type Relay as RelayRow,
  type Selection,
} from "../lib/types.ts"
import {
  isFreeUsageLimit,
  isSelected,
  readResponseState,
  relayRequest,
  selectModels,
  type RoutableModel,
} from "../lib/routing.ts"
import {
  deleteVercelProject,
  deployRelay as deployToVercel,
  inspectVercel,
  probeRelay,
  type DeployRelayResult,
} from "../lib/vercel.ts"
import { projectName, relaySource } from "../lib/relay-source.ts"
import { RelayState, type Settings } from "./state.ts"

/** How long the client waits before trying another relay instance. */
const ROTATE_DELAY_MS = 250

/** How many times one request may be moved to another instance before it is given up on. */
const MAX_ROTATION_RETRIES = 3

/** How long the body of a failed answer is waited for before it is given up on. */
const BODY_TIMEOUT_MS = 2000

/** How long the model list is kept before it is asked for again. */
const MODEL_CACHE_MS = 5000

/** A model as the OpenCode client reports it. */
type ClientModel = Awaited<ReturnType<Context["model"]["list"]>>["data"][number]

/**
 * The plugin's own models, in the shape the routing rules understand.
 *
 * The price is what tells a free model from a paid one, so it is passed on as it
 * is. A model without any pricing is left without pricing: an unknown price is
 * not a zero price, and guessing here would spend the free allowance.
 */
async function openCodeModels(context: Context): Promise<RoutableModel[]> {
  let data: ClientModel[]
  try {
    data = (await context.model.list()).data
  } catch {
    // Without the list nothing can be told apart, so nothing is claimed.
    return []
  }
  // The list comes from a server that may be busy, so anything that is not a
  // plain list of models is treated as no models at all.
  if (!Array.isArray(data)) return []
  return data
    .filter((model) => model.providerID === PROVIDER_ID)
    .map((model) => ({
      id: model.modelID,
      name: model.name,
      ...(Array.isArray(model.cost) && model.cost.length > 0
        ? { cost: model.cost.map((tier) => ({ input: tier.input, output: tier.output })) }
        : {}),
    }))
}

/**
 * The model a request is for, in the shape the routing rules understand.
 *
 * The price is only needed to tell a free model from a paid one, so the caller
 * only brings a list when the selection depends on it.
 */
function requestModel(
  models: readonly RoutableModel[],
  modelId: string,
  selection: Selection,
): RoutableModel {
  if (selection !== "free") return { id: modelId, name: modelId }
  const known = models.find((model) => model.id === modelId)
  return known ?? { id: modelId, name: modelId }
}

/** The message of a failure. */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Takes a secret out of a message, so a failure can be shown without handing out the secret. */
function redact(text: string, secret: string): string {
  if (secret.length === 0) return text
  return text.split(secret).join("***")
}

/** The body of an answer, read from a copy so the answer itself still reaches OpenCode. */
async function readBody(response: Response): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const copy = response.clone()
    const body = await Promise.race([
      copy.text(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), BODY_TIMEOUT_MS)
      }),
    ])
    return body
  } catch {
    return undefined
  } finally {
    // The answer is not waited for forever: a stream that never ends must not hold the request up.
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** A short tail for the project name, so two relays in one region never share a project. */
function projectSuffix(name: string | undefined): string {
  return `${name ?? ""}-${randomBytes(3).toString("hex")}`
}

/** A sentence for the user, saying what the plugin is doing right now. */
function describeState(
  settings: Settings,
  active: RelayRow | undefined,
  routed: number,
  total: number,
): string {
  if (!settings.enabled) return "Routing is off: requests go straight to OpenCode."
  if (!active) return "Routing is on, but no relay is chosen."
  const place = regionLabel(active.region)
  const where = place.length > 0 ? ` in ${place}` : ""
  if (total === 0) return `Routing through ${active.name}${where}.`
  return `Routing ${routed} of ${total} OpenCode models through ${active.name}${where}.`
}

export default Plugin.define({
  id: "opencode-relay",
  async setup(context) {
    const state = new RelayState(context.storage)
    // The state is read before anything is registered, so a request that arrives
    // in the first moments is judged by the same rules as every later one.
    await state.load()

    // The handlers announce a change through the registration, and the registration
    // is built from the handlers, so the link is made once both exist.
    let announce: (reason: string) => Promise<void> = async () => {}

    // The model list is asked for on every request that needs a price, so it is
    // kept for a moment instead of being fetched again and again.
    let cached: { readonly at: number; readonly models: RoutableModel[] } | undefined
    const models = async (): Promise<RoutableModel[]> => {
      const now = Date.now()
      if (cached && now - cached.at < MODEL_CACHE_MS) return cached.models
      const list = await openCodeModels(context)
      // An empty list means the server had nothing to say, which is worth asking again.
      if (list.length > 0) cached = { at: now, models: list }
      return list
    }

    const handlers: RpcHandlers<typeof Relay> = {
      /** What the plugin is doing right now: on or off, through which relay, and what it knows. */
      status: async () => {
        const settings = state.settings()
        const active = state.activeRelay()
        const list = selectModels(
          await models(),
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
          note: describeState(settings, active, routed, list.length),
        }
      },

      /** The models of the OpenCode provider, each flagged free and routed. */
      models: async () => {
        const settings = state.settings()
        const list = selectModels(
          await models(),
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
            message: redact(describe(err), input.token),
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
        const access = randomBytes(24).toString("hex")
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
            message: redact(describe(err), account.token),
          })
        }
        const relay: RelayRow = {
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
        const relay: RelayRow = {
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
              // dashboard is a smaller problem than a failed removal.
              console.warn(
                "opencode-relay: could not delete the Vercel project:",
                redact(describe(err), account.token),
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
            message: redact(describe(err), account.token),
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

    const registration = await context.rpc.register(Relay, handlers)
    announce = async (reason: string) => {
      await registration.events.emit("changed", { reason })
    }

    // The request hook is the only one that changes what OpenCode sends, and it
    // is scoped to the OpenCode provider so no other provider is ever touched.
    const requestHook = await context.session.hook(
      "http.request",
      async (input) => {
        if (input.model.providerID !== PROVIDER_ID) return
        const settings = state.settings()
        if (!settings.enabled) return
        const relay = state.activeRelay()
        if (!relay) return
        const list = settings.selection === "free" ? await models() : []
        const model = requestModel(list, input.model.id, settings.selection)
        if (!isSelected(model, settings.selection, settings.customModels)) return
        input.request = relayRequest(input.request, {
          url: relay.url,
          access: relay.access,
          avoid: state.spentEgresses(relay.id),
        })
      },
      { providerID: PROVIDER_ID },
    )

    // The response hook learns which addresses are used up, so the relay can be
    // asked to skip them from then on.
    const responseHook = await context.session.hook(
      "http.response",
      async (input) => {
        const relay = state.activeRelay()
        if (!relay) return
        const answer = readResponseState(input.response)
        if (answer.rotate) {
          // The instance behind the relay is used up: remember its address, so the
          // next request is sent to another one.
          if (answer.egress !== undefined) state.markSpent(relay.id, answer.egress)
          return
        }
        if (!answer.spent) return
        const body = await readBody(input.response)
        if (body === undefined || !isFreeUsageLimit(body)) return
        if (answer.egress !== undefined) state.markSpent(relay.id, answer.egress)
      },
      { providerID: PROVIDER_ID },
    )

    // The retry hook moves a request that landed on a used up instance to another one.
    const retryHook = await context.session.hook(
      "retry",
      async (input) => {
        const rotation =
          input.error.status === 409 || (input.error.response?.body ?? "").includes("used up")
        if (!rotation) return
        if (input.attempt >= MAX_ROTATION_RETRIES) return
        input.decision = { retry: true, delay: ROTATE_DELAY_MS }
      },
      { providerID: PROVIDER_ID },
    )

    return async () => {
      await Promise.all([
        requestHook.dispose(),
        responseHook.dispose(),
        retryHook.dispose(),
      ])
      await registration.dispose()
    }
  },
})
