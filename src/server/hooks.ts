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
import { PROVIDER_ID, UPSTREAM_HOST, nextResetAt } from "../lib/types.ts"
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

/**
 * Whether a request is addressed to the upstream this plugin may forward to.
 *
 * The provider id alone is not proof: a provider can be named "opencode" and
 * point somewhere else. Such a request carries that provider's own key, and
 * routing it to the relay would send the key to a host the user did not choose.
 */
function isUpstreamRequest(url: URL): boolean {
  const host = url.hostname.toLowerCase()
  return host === UPSTREAM_HOST || host.endsWith(`.${UPSTREAM_HOST}`)
}

/** A 4xx that says the request itself was wrong; another exit would refuse it too. */
function isRequestFault4xx(code: number): boolean {
  return code === 400 || code === 413 || code === 422
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
      const sessionID = input.sessionID ?? ""
      const modelId = input.model.id
      // Every request starts with a clean slate: an answer from an earlier
      // request must never be blamed on an exit this one did not use.
      state.forgetRelayed(sessionID, modelId)

      // Before anything is routed, the request must actually be OpenCode's own
      // traffic. A provider named "opencode" with another baseURL carries that
      // provider's key, and forwarding it would leak the key to opencode.ai.
      let url: URL | undefined
      try {
        const raw = input.request?.url
        url = raw === undefined ? undefined : new URL(raw)
      } catch {
        url = undefined
      }
      if (url === undefined) {
        state.noteDecision({
          modelId,
          routed: false,
          reason: "The request URL could not be read, so the request was left unchanged.",
        })
        return
      }
      if (!isUpstreamRequest(url)) {
        state.noteDecision({
          modelId,
          routed: false,
          reason: `The request is not addressed to ${UPSTREAM_HOST}, so it was left unchanged.`,
        })
        return
      }

      const settings = state.settings()

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
        path: `${url.pathname}${url.search}`,
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
      if (input.model.providerID !== PROVIDER_ID) return
      if (!state.settings().enabled) return
      const exitId = exitIdOf(input.request)
      if (exitId === undefined) return
      const exit = state.exit(exitId)
      if (!exit) return
      const sessionID = input.sessionID ?? ""
      const modelId = input.model.id
      const timing = state.finishTiming(sessionID, modelId)
      const answer = readResponseState(input.response)
      // A proxy has no relay headers to say where the answer came from: reaching
      // the proxy is reaching the upstream. A relay has to say so itself.
      const reached = exit.kind === "proxy" ? true : answer.reachedExit
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
        const contentType = input.response.headers.get("content-type")?.toLowerCase() ?? ""
        // Not every answer below 400 carried the request. A 204/205 has no
        // body, a 3xx is a detour, an HTML page is a captive portal or an error
        // dressed as 200, and a relay answer without its own headers never
        // reached the upstream. None of them is proof the exit works.
        const empty = code === 204 || code === 205
        const redirect = code >= 300
        const html = contentType.includes("text/html")
        const missed = exit.kind === "relay" && !answer.reachedExit
        if (empty || redirect || html || missed) {
          const note =
            missed
              ? `The exit answered with HTTP ${code} without reaching the relay's upstream.`
              : `The exit answered with HTTP ${code}, which is not a model response.`
          state.markFailed(exitId)
          state.markFailure(exitId, note, "bad")
          state.noteFailureContext(sessionID, modelId, {
            at: Date.now(),
            exitId,
            kind: "server",
            reached,
            note,
          })
          return
        }
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

      if (code === 409) {
        // A 409 without the rotation header is not a spent address: it is the
        // upstream (or the bridge) refusing this request. Record it like any
        // other failed answer, so the stats, the rest and the note all agree,
        // and let the retry hook judge from the context instead of the status.
        state.markFailed(exitId)
        state.markFailure(exitId, `The exit answered with HTTP ${code}.`, "bad")
        state.noteFailureContext(sessionID, modelId, {
          at: Date.now(),
          exitId,
          kind: "server",
          reached: true,
          note: `The exit answered with HTTP ${code}.`,
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
        return
      }

      // What is left is a 4xx no branch above named. The status still says
      // whether the exit or the request was the problem, and only the first is
      // worth another exit: rotating cannot fix a malformed request.
      if (isRequestFault4xx(code)) {
        const note = `The exit answered with HTTP ${code}; the request itself was refused.`
        state.markFailed(exitId)
        state.noteFailureContext(sessionID, modelId, {
          at: Date.now(),
          exitId,
          kind: "refused",
          reached,
          note,
        })
        return
      }

      state.markFailed(exitId)
      state.markFailure(exitId, `The exit answered with HTTP ${code}.`, "bad")
      state.noteFailureContext(sessionID, modelId, {
        at: Date.now(),
        exitId,
        kind: "server",
        reached,
        note: `The exit answered with HTTP ${code}.`,
      })
    },
    { providerID: PROVIDER_ID },
  )

  // The retry hook moves a request that landed on an exit that cannot serve it
  // to another one, when that is worth doing. A refused request is not retried:
  // the request was the problem, and another address would refuse it too.
  const retry = await context.session.hook(
    "retry",
    async (input) => {
      if (input.model.providerID !== PROVIDER_ID) return
      const sessionID = input.sessionID ?? ""
      const exitId = state.relayedBy(sessionID, input.model.id)
      if (exitId === undefined) return
      const exit = state.exit(exitId)
      if (!exit) return
      if (input.attempt >= MAX_ROTATION_RETRIES) return

      const settings = state.settings()
      // Another attempt is worth asking for when another exit can serve, or
      // when the request may fall back to OpenCode itself.
      const canRetry = (): boolean =>
        state.canRetryAfterAllowance() || settings.direct === "allow"

      const status = input.error.status
      if (status === undefined || status === 0) {
        // Nothing answered: the host was not found, the connection was refused,
        // TLS said no. The exit gets a rest, and another attempt may land on
        // one that works, or go direct when the user allows it. Without either,
        // the request hook would only replace the real error with a routing
        // failure, so the decision is left alone. The mark is taken before the
        // gate, so the exit that just failed cannot count as the way out.
        state.markFailure(exitId, input.error.message ?? "The exit did not answer.", "unreachable")
        if (!canRetry()) return
        input.decision = { retry: true, delay: ROTATE_DELAY_MS }
        return
      }

      const context: FailureContext | undefined = state.failureFor(sessionID, input.model.id)
      if (status < 400) {
        // The response hook rejected this as not a model answer (a 204, a
        // redirect, an HTML page, or a relay answer that never reached its
        // upstream). The exit is already rested; only ask for another attempt
        // when one can actually serve.
        if (context?.kind !== "server") return
        if (!canRetry()) return
        input.decision = { retry: true, delay: ROTATE_DELAY_MS }
        return
      }

      if (status === 429) {
        const body = input.error.response?.body
        const text = typeof body === "string" ? body : ""
        // The response hook normally decided this already. If it did not (a
        // transport layer that skipped it), the safe answer is to try another
        // exit only when one can serve, never to keep hammering this one.
        if (context?.kind === "refused" || context?.kind === "blocked") return
        if (context === undefined && !isFreeUsageLimit(text)) return
        // A used-up free allowance leaves no exit behind, but the request can
        // still go direct when the user allows it, exactly like a used-up
        // relay (409) or a refused exit (401/403). Without either, it would
        // just die here.
        if (!canRetry()) return
        input.decision = {
          retry: true,
          delay: context?.kind === "rate-limited" ? 1000 : ROTATE_DELAY_MS,
        }
        return
      }

      if (status === 409) {
        // Only a relay that asked for another instance, or a refusal that
        // confirmed the address is used up, is a reason to send the same
        // request somewhere else. A bare 409 is the request's own conflict:
        // another exit would answer it the same way.
        if (context?.kind !== "rotate" && context?.kind !== "exhausted") return
        // A used-up relay leaves no exit behind, but the request can still go
        // direct when the user allows it. Without that, it would just die.
        if (!canRetry()) return
        input.decision = { retry: true, delay: ROTATE_DELAY_MS }
        return
      }

      if (status === 401 || status === 403) {
        // The exit was refused, and the response hook already marked it
        // blocked. The request itself is still worth sending elsewhere or
        // direct; marking it again here would only double the blame.
        if (!canRetry()) return
        input.decision = { retry: true, delay: ROTATE_DELAY_MS }
        return
      }

      if (status >= 500) {
        // The response hook counted and rested this failure already. Only a
        // retry that arrived without that context needs its single mark here.
        if (context === undefined) {
          state.markFailure(exitId, input.error.message ?? `HTTP ${status}`, "bad")
        }
        if (!canRetry()) return
        input.decision = { retry: true, delay: ROTATE_DELAY_MS }
        return
      }

      // A malformed request is not fixed by sending it from another address:
      // record it, but leave the exit in use and do not rotate.
      if (isRequestFault4xx(status)) return

      // Every other 4xx was classified as an exit fault by the response hook
      // (404, 407, 408, 425, 451, and the statuses it does not recognise). The
      // exit is already rested, so only the decision is left.
      if (!canRetry()) return
      input.decision = { retry: true, delay: ROTATE_DELAY_MS }
    },
    { providerID: PROVIDER_ID },
  )

  return { request, response, retry }
}
