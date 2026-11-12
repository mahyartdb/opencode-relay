/**
 * The three hooks that decide what OpenCode sends, and what happens when the
 * relay cannot serve it.
 *
 * These are the only places where the plugin changes anything about a request,
 * and they are deliberately narrow: only the OpenCode provider's own requests
 * are touched, and only when the plugin is on, a relay is picked and the model
 * is selected. Everything else is left exactly as it was.
 */
import type { Context } from "@opencode/plugin/promise/plugin"
import { PROVIDER_ID } from "../lib/types.ts"
import {
  isFreeUsageLimit,
  isSelected,
  readResponseState,
  relayIdOf,
  relayRequest,
} from "../lib/routing.ts"
import type { ModelCatalog } from "./models.ts"
import type { RelayState } from "./state.ts"

/** How long the client waits before trying another relay instance. */
export const ROTATE_DELAY_MS = 250

/** How many times one request may be moved to another instance before it is given up on. */
export const MAX_ROTATION_RETRIES = 3

/** How long the body of a failed answer is waited for before it is given up on. */
const BODY_TIMEOUT_MS = 2000

/** What the hooks need from the outside world. */
export interface HookDeps {
  readonly state: RelayState
  readonly catalog: ModelCatalog
}

/**
 * The body of an answer, read from a copy so the answer itself still reaches OpenCode.
 *
 * The body belongs to the caller, streaming, and reading it here would eat the
 * answer before it reaches OpenCode.
 */
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

/** The registrations of the three hooks, so they can be disposed of. */
export interface HookRegistrations {
  readonly request: { readonly dispose: () => Promise<void> }
  readonly response: { readonly dispose: () => Promise<void> }
  readonly retry: { readonly dispose: () => Promise<void> }
}

/** Registers the three session hooks. */
export async function registerHooks(
  context: Context,
  deps: HookDeps,
): Promise<HookRegistrations> {
  const { state, catalog } = deps

  // The request hook is the only one that changes what OpenCode sends, and it
  // is scoped to the OpenCode provider so no other provider is ever touched.
  const request = await context.session.hook(
    "http.request",
    async (input) => {
      if (input.model.providerID !== PROVIDER_ID) return
      const settings = state.settings()
      if (!settings.enabled) return
      const list = settings.selection === "free" ? await catalog.list() : []
      const model = catalog.resolve(list, input.model.id, settings.selection)
      if (!isSelected(model, settings.selection, settings.customModels)) return
      // The strategy decides which relay serves this request: one relay always,
      // one request each in turn, or one until its allowance is gone. This runs
      // only once the model is known to be routed, so a model that stays direct
      // never moves the rotation on.
      const relay = state.pickRelay()
      if (!relay) return
      input.request = relayRequest(input.request, {
        id: relay.id,
        url: relay.url,
        access: relay.access,
        avoid: state.spentEgresses(relay.id),
      })
      state.noteRelayed(input.sessionID, input.model.id, relay.id)
    },
    { providerID: PROVIDER_ID },
  )

  /*
   * When something is used up, and what follows from it:
   * - the relay answers 409, or marks the answer with x-relay-rotate, when the
   *   instance behind it is spent. The address it used is remembered and
   *   another attempt is asked for.
   * - the provider answers 429 when the free allowance of an address is gone.
   *   The address is remembered and the relay steps aside, whatever the body
   *   says. Another attempt is only worth asking for when the body is a free
   *   usage limit, the request went through this plugin, and an address that
   *   still works can be reached.
   */
  // The response hook learns which addresses are used up, so the relay can be
  // asked to skip them from then on.
  const response = await context.session.hook(
    "http.response",
    async (input) => {
      // The request says which relay carried it, so a round robin answer is
      // attributed to the relay that actually served it rather than to the one
      // the user happens to have chosen.
      const relayId = relayIdOf(input.request)
      if (relayId === undefined) return
      const relay = state.relay(relayId)
      if (!relay) return
      // With routing off the request went straight to OpenCode, so any answer
      // has nothing to do with the relay and nothing to remember.
      if (!state.settings().enabled) return
      const answer = readResponseState(input.response)
      if (answer.rotate) {
        // The instance behind the relay is used up: remember its address, so the
        // next request is sent to another one.
        if (answer.egress !== undefined) state.markSpent(relay.id, answer.egress)
        return
      }
      if (!answer.spent) return
      // A 429 means the free allowance is gone. The wording of the body says
      // why, but it must not decide whether the relay steps aside: a wording we
      // do not recognise would otherwise keep using an address that is spent.
      const body = await readBody(input.response)
      // The address is only known when the relay could look it up, so it is
      // remembered when it is there, and the relay still steps aside when it is not.
      if (answer.egress !== undefined) {
        state.markSpent(relay.id, answer.egress)
        if (body !== undefined) state.noteSpendReason(answer.egress, body)
      }
      state.markExhausted(relay.id)
    },
    { providerID: PROVIDER_ID },
  )

  // The retry hook moves a request that landed on a used up instance to another one.
  const retry = await context.session.hook(
    "retry",
    async (input) => {
      // Only a request this plugin routed can be blamed on a relay. A direct
      // answer that happens to look like a relay signal is left alone.
      const relayId = state.relayedBy(input.sessionID, input.model.id)
      if (relayId === undefined) return
      // A failure with no HTTP status never reached the relay: the host was not
      // found, the connection was refused, TLS said no. The relay is skipped
      // for a while, so the retry (and the rest of the session) is not sent to
      // the same dead end.
      if (input.error.status === undefined || input.error.status === 0) {
        state.markRelayFailure(relayId)
        if (input.attempt >= MAX_ROTATION_RETRIES) return
        input.decision = { retry: true, delay: ROTATE_DELAY_MS }
        return
      }
      // A relay that answers with a server error did not carry the request, so
      // it is given a rest as well. The next attempt goes direct or to another
      // relay, which is better than sending the same request at the same wall.
      if (input.error.status >= 500) {
        state.markRelayFailure(relayId)
        if (input.attempt >= MAX_ROTATION_RETRIES) return
        input.decision = { retry: true, delay: ROTATE_DELAY_MS }
        return
      }
      const body = input.error.response?.body
      const text = typeof body === "string" ? body : undefined
      const rotation = input.error.status === 409 || (text !== undefined && text.includes("used up"))
      const allowance =
        input.error.status === 429 &&
        text !== undefined &&
        isFreeUsageLimit(text) &&
        state.canRetryAfterAllowance()
      if (!rotation && !allowance) return
      if (input.attempt >= MAX_ROTATION_RETRIES) return
      input.decision = { retry: true, delay: ROTATE_DELAY_MS }
    },
    { providerID: PROVIDER_ID },
  )

  return { request, response, retry }
}