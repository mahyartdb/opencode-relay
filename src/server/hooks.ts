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
import { isSelected, readResponseState, relayRequest } from "../lib/routing.ts"
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
      const relay = state.activeRelay()
      if (!relay) return
      const list = settings.selection === "free" ? await catalog.list() : []
      const model = catalog.resolve(list, input.model.id, settings.selection)
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
  const response = await context.session.hook(
    "http.response",
    async (input) => {
      const relay = state.activeRelay()
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
      // The relay said which address it used, and a 429 means that address
      // cannot serve more for now. The wording of the body says why, but it must
      // not decide whether the address is avoided: a wording we do not recognise
      // would otherwise keep using an address that is already spent.
      if (answer.egress === undefined) return
      state.markSpent(relay.id, answer.egress)
      const body = await readBody(input.response)
      if (body !== undefined) state.noteSpendReason(answer.egress, body)
    },
    { providerID: PROVIDER_ID },
  )

  // The retry hook moves a request that landed on a used up instance to another one.
  const retry = await context.session.hook(
    "retry",
    async (input) => {
      const body = input.error.response?.body
      const rotation =
        input.error.status === 409 || (typeof body === "string" && body.includes("used up"))
      if (!rotation) return
      if (input.attempt >= MAX_ROTATION_RETRIES) return
      input.decision = { retry: true, delay: ROTATE_DELAY_MS }
    },
    { providerID: PROVIDER_ID },
  )

  return { request, response, retry }
}