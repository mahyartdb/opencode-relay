/**
 * The three hooks that decide what OpenCode sends, and what happens when an
 * exit cannot serve it.
 *
 * These are the only places where the plugin changes anything about a request.
 * Only the OpenCode provider's own requests are touched, and only a request
 * whose model is free and chosen is ever rewritten; everything else is left
 * exactly as it was. What the plugin *decided* about a request - including a
 * request it left alone - is recorded either way, so the status note and the
 * preview can say the truth instead of guessing.
 *
 * The response hook is where a free allowance is confirmed. A 429 alone is not
 * proof: OpenCode also refuses individual requests. The exit is only retired
 * after a one-token canary through the same exit is refused as well.
 */
import type { Context } from "@opencode/plugin/promise/plugin"
import { PROVIDER_ID, nextResetAt } from "../lib/types.ts"
import {
  isFreeUsageLimit,
  parseRetryAfter,
  proxyRequest,
  readBody,
  readResponseState,
  relayRequest,
  exitIdOf,
} from "../lib/routing.ts"
import type { ProxyBridge } from "./bridge.ts"
import { decideModel } from "./decide.ts"
import type { ModelCatalog } from "./models.ts"
import {
  REFUSED_COOLDOWN_MS,
  RATE_LIMIT_COOLDOWN_MS,
  type FailureContext,
  type RelayState,
} from "./state.ts"
import type { Tester } from "./tester.ts"

/** How long the client waits before trying another exit. */
export const ROTATE_DELAY_MS = 250

/** How many times one request may be moved to another exit before it is given up on. */
export const MAX_ROTATION_RETRIES = 3

/** What the hooks need from the outside world. */
export interface HookDeps {
  readonly state: RelayState
  readonly catalog: ModelCatalog
  readonly bridge: ProxyBridge
  readonly tester: Tester
}

/** The registrations of the three hooks, so they can be disposed of. */
export interface HookRegistrations {
  readonly request: { readonly dispose: () => Promise<void> }
  readonly response: { readonly dispose: () => Promise<void> }
  readonly retry: { readonly dispose: () => Promise<void> }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The headers of a request, as a sample a test can replay. */
function headerRecord(request: Request): Record<string, string> {
  const headers: Record<string, string> = {}
  request.headers.forEach((value, name) => {
    headers[name] = value
  })
  return headers
}

/** Registers the three session hooks. */
export async function registerHooks(
  context: Context,
  deps: HookDeps,
): Promise<HookRegistrations> {
  const { state, catalog, bridge, tester } = deps

  // The request hook is the only one that changes what OpenCode sends, and it
  // is scoped to the OpenCode provider so no other provider is ever touched.
  const request = await context.session.hook(
    "http.request",
    async (input) => {
      if (input.model.providerID !== PROVIDER_ID) return
      const settings = state.settings()
      const sessionID = input.sessionID ?? ""
      const modelId = input.model.id
      // Every request starts with a clean slate: an answer from an earlier
      // request must never be blamed on an exit this one did not use.
      state.forgetRelayed(sessionID, modelId)

      // The one decision, shared with the preview, so the menu and the hook
      // can never disagree about why a request went direct.
      const decision = await decideModel(
        { state, catalog, bridgeReady: bridge.ready },
        { providerID: input.model.providerID, modelId, advance: true },
      )
      if (!decision.routed) {
        state.noteDecision({ modelId, routed: false, reason: decision.reason })
        // Only a request that was meant to be routed and could not be is a
        // failure. Switching off, another provider, an unlisted model and a
        // model outside the chosen list are direct by policy, which is the
        // documented behavior, not an error worth failing the request over.
        if (
          settings.direct === "never" &&
          (decision.kind === "no-exit" || decision.kind === "bridge")
        ) {
          throw new Error(
            `${decision.reason} The plugin is set to never go direct, so the request was not sent.`,
          )
        }
        return
      }
      const exit = decision.exit
      // Only a routed decision carries an exit; without one there is nothing
      // to rewrite, and sending it unchanged would be a silent direct request.
      if (!exit) return

      // The request is remembered before it is rewritten, so a test later can
      // look exactly like the request OpenCode Free is willing to answer.
      // It is taken here, and only for routed models: a sample of a request
      // that never went through an exit would make a test look like traffic
      // this plugin never sent.
      state.noteSample({
        modelID: modelId,
        path: `${new URL(input.request.url).pathname}${new URL(input.request.url).search}`,
        headers: headerRecord(input.request),
      })

      // The exit is chosen here; the in-memory timing starts now. A request that
      // never reaches the exit still has a started mark, which the response
      // hook clears when the failure surfaces.
      state.noteStarted(sessionID, modelId)
      state.noteRequest(exit.id)
      try {
        if (exit.kind === "relay") {
          input.request = relayRequest(input.request, {
            id: exit.id,
            url: exit.url,
            access: exit.access,
            avoid: state.spentEgresses(),
          })
        } else {
          input.request = proxyRequest(input.request, {
            bridge: bridge.origin,
            key: bridge.key,
            id: exit.id,
          })
        }
      } catch (error) {
        state.markFailure(exit.id, errorText(error))
        state.noteDecision({
          modelId,
          routed: false,
          reason: `${exit.name} could not be prepared: ${errorText(error)}`,
        })
        if (settings.direct === "never") throw error
        return
      }
      state.noteRelayed(sessionID, modelId, exit.id)
      state.noteDecision({
        modelId,
        routed: true,
        reason: `The request went through ${exit.name}.`,
        exitId: exit.id,
        exitName: exit.name,
        kind: exit.kind,
      })
    },
    { providerID: PROVIDER_ID },
  )

  /*
   * The response hook turns an answer into what the plugin knows:
   *
   * - A 2xx says the exit works. Its latency feeds the fastest strategy.
   * - A 409 is the relay saying its instance's address is spent. The address is
   *   remembered and another attempt is worth asking for.
   * - A 429 is only a suspicion. The body and a canary decide whether the
   *   address is spent or the request was refused.
   */
  const response = await context.session.hook(
    "http.response",
    async (input) => {
      if (!state.settings().enabled) return
      const exitId = exitIdOf(input.request)
      if (exitId === undefined) return
      const exit = state.exit(exitId)
      if (!exit) return
      const sessionID = input.sessionID ?? ""
      const modelId = input.model.id
      const timing = state.finishTiming(sessionID, modelId)
      const answer = readResponseState(input.response)
      state.noteEgress(exitId, answer.egress, answer.runtime)

      if (answer.rotate) {
        const until = nextResetAt()
        if (answer.egress !== undefined) state.markSpent(answer.egress, until)
        state.markRotated(exitId)
        state.markExhausted(exitId, until, "The address behind this relay is used up.")
        state.noteFailureContext(sessionID, modelId, {
          at: Date.now(),
          exitId,
          kind: "rotate",
          reached: true,
          until,
          note: "The relay asked for another instance.",
        })
        return
      }

      const code = input.response.status
      if (code < 400) {
        state.markSuccess(exitId, timing)
        return
      }

      if (code === 429) {
        state.markLimited(exitId)
        const body = (await readBody(input.response, 2500, 4000)) ?? ""
        if (!isFreeUsageLimit(body)) {
          const until =
            Date.now() +
            Math.max(
              parseRetryAfter(input.response.headers.get("retry-after")),
              RATE_LIMIT_COOLDOWN_MS,
            )
          state.markRateLimited(exitId, until, "OpenCode rate-limited this exit.")
          state.noteFailureContext(sessionID, modelId, {
            at: Date.now(),
            exitId,
            kind: "rate-limited",
            reached: true,
            until,
            note: "OpenCode rate-limited this exit.",
          })
          return
        }

        // The request was refused. Ask once more, tiny, through the same exit:
        // only a canary that is refused too says the address is used up.
        const canary = await tester.canary(exit)
        if (canary === "spent") {
          const wait = parseRetryAfter(input.response.headers.get("retry-after"))
          const until = wait > 0 ? Date.now() + Math.min(wait, 24 * 60 * 60_000) : nextResetAt()
          if (answer.egress !== undefined) state.markSpent(answer.egress, until)
          else if (exit.egress !== undefined) state.markSpent(exit.egress, until)
          state.markExhausted(exitId, until, "OpenCode confirmed the free allowance of this address is used up.")
          state.noteFailureContext(sessionID, modelId, {
            at: Date.now(),
            exitId,
            kind: "exhausted",
            reached: true,
            until,
            note: "The free allowance of this exit is gone.",
          })
          return
        }
        // Either the request itself was refused, or the canary could not tell.
        // Neither is a reason to keep the exit out of use for long, and neither
        // is a reason to retry the same request through another address.
        const until = Date.now() + REFUSED_COOLDOWN_MS
        const note =
          canary === "clean"
            ? "OpenCode refused this request; the exit itself still works."
            : "OpenCode refused this request; the exit could not be confirmed either way."
        state.markRateLimited(exitId, until, note)
        state.noteFailureContext(sessionID, modelId, {
          at: Date.now(),
          exitId,
          kind: "refused",
          reached: true,
          until,
          note,
        })
        return
      }

      if (code === 401 || code === 403) {
        state.markBlocked(exitId, `OpenCode refused this exit (HTTP ${code}).`)
        state.noteFailureContext(sessionID, modelId, {
          at: Date.now(),
          exitId,
          kind: "blocked",
          reached: true,
          note: `OpenCode refused this exit (HTTP ${code}).`,
        })
        return
      }

      if (code >= 500) {
        state.markFailed(exitId)
        state.markFailure(exitId, `The exit answered with HTTP ${code}.`, "bad")
        state.noteFailureContext(sessionID, modelId, {
          at: Date.now(),
          exitId,
          kind: "server",
          reached: true,
          note: `The exit answered with HTTP ${code}.`,
        })
      }
    },
    { providerID: PROVIDER_ID },
  )

  // The retry hook moves a request that landed on an exit that cannot serve it
  // to another one, when that is worth doing. A refused request is not retried:
  // the request was the problem, and another address would refuse it too.
  const retry = await context.session.hook(
    "retry",
    async (input) => {
      const sessionID = input.sessionID ?? ""
      const exitId = state.relayedBy(sessionID, input.model.id)
      if (exitId === undefined) return
      const exit = state.exit(exitId)
      if (!exit) return
      if (input.attempt >= MAX_ROTATION_RETRIES) return

      const status = input.error.status
      if (status === undefined || status === 0) {
        // Nothing answered: the host was not found, the connection was refused,
        // TLS said no. The exit gets a rest, and another attempt may land on
        // one that works.
        state.markFailure(exitId, input.error.message ?? "The exit did not answer.", "unreachable")
        input.decision = { retry: true, delay: ROTATE_DELAY_MS }
        return
      }

      const context: FailureContext | undefined = state.failureFor(sessionID, input.model.id)
      if (status === 429) {
        const body = input.error.response?.body
        const text = typeof body === "string" ? body : ""
        // The response hook normally decided this already. If it did not (a
        // transport layer that skipped it), the safe answer is to try another
        // exit only when one can serve, never to keep hammering this one.
        if (context?.kind === "refused" || context?.kind === "blocked") return
        if (context?.kind === "exhausted" && !state.canRetryAfterAllowance()) return
        if (context === undefined && !isFreeUsageLimit(text)) return
        if (!state.canRetryAfterAllowance()) return
        input.decision = {
          retry: true,
          delay: context?.kind === "rate-limited" ? 1000 : ROTATE_DELAY_MS,
        }
        return
      }

      if (status === 409) {
        if (!state.canRetryAfterAllowance()) return
        input.decision = { retry: true, delay: ROTATE_DELAY_MS }
        return
      }

      if (status >= 500) {
        state.markFailure(exitId, input.error.message ?? `HTTP ${status}`, "bad")
        input.decision = { retry: true, delay: ROTATE_DELAY_MS }
      }
    },
    { providerID: PROVIDER_ID },
  )

  return { request, response, retry }
}
