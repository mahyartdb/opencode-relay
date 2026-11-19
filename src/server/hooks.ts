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
  /**
   * Says that the traffic counters moved.
   *
   * The footer counts the requests that went through an exit, and only the
   * server knows when one did. Without this the number on the pill would
   * freeze at zero while traffic flowed.
   */
  readonly announceTraffic: () => void
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

/**
 * How long the response hook waits for a canary before it stops waiting.
 *
 * The canary's own budget is longer, because a check somebody asked for may
 * take its time. A 429 cannot: the answer is held open while the canary runs,
 * so an exit that has not answered by now has told the caller nothing, which
 * is the same verdict as a canary that timed out.
 */
const INLINE_CANARY_MS = 10_000

/** Settle with the fallback when the work has not answered in time. */
function bounded<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
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

  /**
   * Says that traffic moved, at most once a second.
   *
   * Every routed request is an event, and every event is a status refresh on
   * the other side. Announcing each one would make the plugin talk to
   * itself in a storm, so the announcements are throttled and the last one
   * is always delivered: a request that arrived during the quiet window
   * still gets its count onto the pill.
   */
  const TRAFFIC_INTERVAL_MS = 1_000
  let lastAnnounced = 0
  let pending: ReturnType<typeof setTimeout> | undefined
  const announceTraffic = (): void => {
    const now = Date.now()
    const wait = Math.max(0, TRAFFIC_INTERVAL_MS - (now - lastAnnounced))
    if (wait === 0) {
      lastAnnounced = now
      deps.announceTraffic()
      return
    }
    if (pending !== undefined) return
    pending = setTimeout(() => {
      pending = undefined
      lastAnnounced = Date.now()
      deps.announceTraffic()
    }, wait)
  }

  // The request hook is the only one that changes what OpenCode sends, and it
  // is scoped to the OpenCode provider so no other provider is ever touched.
  const request = await context.session.hook(
    "http.request",
    async (input) => {
      if (input.model.providerID !== PROVIDER_ID) return
      const sessionID = input.sessionID ?? ""
      const modelId = input.model.id
      // The kind of request this is: a session's title request runs beside
      // its agent loop with the same model, and the two must not take each
      // other's notes.
      const kind = input.kind ?? "primary"
      // Every request starts with a clean slate: an answer from an earlier
      // request must never be blamed on an exit this one did not use.
      state.forgetRelayed(sessionID, modelId, kind)

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
        // A model list that could not be read is different: the plugin
        // cannot tell whether this model is free, so going direct would spend
        // the user's own allowance on a model that may well have been routed.
        if (
          settings.direct === "never" &&
          (decision.kind === "no-exit" ||
            decision.kind === "bridge" ||
            decision.kind === "catalog")
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

      try {
        // The timing starts with the rewrite, so a request that fails on its
        // way to the exit still has a started mark. A rewrite that throws
        // leaves none: the catch takes it back.
        state.noteStarted(sessionID, modelId, exit.id, kind)
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
        // Nothing about this request reached the exit, so nothing may be
        // charged to it: a started mark would make the retry hook certain
        // about an exit the request never used, and a rest for the direct
        // request's own failure would double this one and bury the rewrite
        // error in the note.
        state.forgetRelayed(sessionID, modelId, kind)
        state.markFailure(exit.id, errorText(error))
        state.noteDecision({
          modelId,
          routed: false,
          reason: `${exit.name} could not be prepared: ${errorText(error)}`,
        })
        if (settings.direct === "never") throw error
        return
      }
      // The request is remembered only once it was actually rewritten, so a
      // test later can look exactly like the request OpenCode Free is willing
      // to answer. A sample of a request that never went through an exit would
      // make a test look like traffic this plugin never sent.
      state.noteSample({
        modelID: modelId,
        path: `${url.pathname}${url.search}`,
        headers: headerRecord(input.request),
      })
      // The request count moved, and the footer counts requests that went
      // through an exit. Saying so is what keeps the number on the pill true
      // while traffic happens. A rewrite that threw never left the machine,
      // so neither the count nor the announcement happens for it.
      state.noteRequest(exit.id)
      announceTraffic()
      state.noteRelayed(sessionID, modelId, exit.id, kind)
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
      const exitId = exitIdOf(input.request)
      if (exitId === undefined) return
      const exit = state.exit(exitId)
      if (!exit) return
      const sessionID = input.sessionID ?? ""
      const modelId = input.model.id
      // The kind of request this is: a session's title request runs beside
      // its agent loop with the same model, and the two must not take each
      // other's timing or blame.
      const kind = input.kind ?? "primary"
      // Routing was switched off while this request was in flight. Nothing
      // can be concluded about the exit, but the request's own mark must be
      // cleared: one left behind would make the retry hook take the request
      // for one that is still waiting for an answer.
      if (!state.settings().enabled) {
        state.finishTiming(sessionID, modelId, kind)
        return
      }
      const timing = state.finishTiming(sessionID, modelId, kind)
      const answer = readResponseState(input.response)
      // The bridge answers a few requests itself: a wrong secret, a target it
      // does not allow, a proxy that is gone. Those answers say nothing about
      // the exit behind them, so they are not booked as its health. A bridge
      // that could not carry the request is the exception: that is the proxy
      // failing, and it has to be rested and counted.
      if (input.response.headers.get("x-bridge-error") === "1") {
        const code = input.response.status
        if (code >= 500) {
          state.markFailed(exitId)
          state.markFailure(exitId, "The proxy could not carry the request.", "unreachable")
        }
        state.noteFailureContext(sessionID, modelId, {
          at: Date.now(),
          exitId,
          kind: "server",
          reached: false,
          note:
            code >= 500
              ? "The proxy could not carry the request."
              : "The local proxy bridge refused the request.",
        }, kind)
        return
      }
      // A proxy has no relay headers to say where the answer came from: reaching
      // the proxy is reaching the upstream. A relay has to say so itself.
      const reached = exit.kind === "proxy" ? true : answer.reachedExit
      state.noteEgress(exitId, answer.egress, answer.runtime)

      if (answer.rotate) {
        // The rotate signal is the relay's own echo of the avoid list: the
        // plugin already told it the address is used up, and the relay
        // answers instead of calling OpenCode. It is not evidence from the
        // provider, so it must not retire the exit for longer than the
        // provider said, and it must not push the address's window further
        // out.
        const known = answer.egress !== undefined ? state.spentUntil(answer.egress) : undefined
        if (known !== undefined) {
          // The address is known to be spent, for a window the provider gave:
          // the exit rests until then, and the window is not pushed out.
          state.markExhausted(exitId, known, "The address behind this relay is used up.")
        } else {
          // The window has passed, so the echo is stale: the address is free
          // again and must not be marked spent for longer. The relay still
          // refused the request, so the exit rests for a while.
          state.markRateLimited(
            exitId,
            Date.now() + REFUSED_COOLDOWN_MS,
            "The relay asked for another instance.",
          )
        }
        state.markRotated(exitId)
        state.noteFailureContext(sessionID, modelId, {
          at: Date.now(),
          exitId,
          kind: "rotate",
          reached: true,
          until: known,
          note: "The relay asked for another instance.",
        }, kind)
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
          }, kind)
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
          }, kind)
          return
        }

        // The request was refused. Ask once more, tiny, through the same exit:
        // only a canary that is refused too says the address is used up.
        const canary = await bounded(tester.canary(exit), INLINE_CANARY_MS, "inconclusive")
        if (canary === "spent") {
          const wait = parseRetryAfter(input.response.headers.get("retry-after"))
          const until = wait > 0 ? Date.now() + Math.min(wait, 24 * 60 * 60_000) : nextResetAt()
          if (answer.egress !== undefined) {
            state.markSpent(answer.egress, until)
            state.noteSpendReason(answer.egress, body)
          } else if (exit.egress !== undefined) {
            state.markSpent(exit.egress, until)
            state.noteSpendReason(exit.egress, body)
          }
          state.markExhausted(exitId, until, "OpenCode confirmed the free allowance of this address is used up.")
          state.noteFailureContext(sessionID, modelId, {
            at: Date.now(),
            exitId,
            kind: "exhausted",
            reached: true,
            until,
            note: "The free allowance of this exit is gone.",
          }, kind)
          return
        }
        // Either the request itself was refused, or the canary could not tell.
        // Neither is a reason to keep the exit out of use for long, and neither
        // is a reason to retry the same request through another address.
        //
        // A canary that answered proves the exit works: the refusal was about
        // the request, so the exit is rested for a moment rather than for a
        // quarter of an hour. A canary that could not tell leaves the doubt
        // where it was.
        const clean = canary === "clean"
        const until = Date.now() + (clean ? RATE_LIMIT_COOLDOWN_MS : REFUSED_COOLDOWN_MS)
        const note = clean
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
        }, kind)
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
        }, kind)
        return
      }

      if (code === 401 || code === 403) {
        // A relay that never reached the upstream refused the plugin itself:
        // the access token is wrong, or the target is not allowed. That is a
        // configuration mistake, not OpenCode turning the exit away, and
        // saying otherwise would blame the wrong party.
        if (!reached) {
          const note = `The relay refused the plugin's access token (HTTP ${code}).`
          state.markFailure(exitId, note, "bad")
          state.noteFailureContext(sessionID, modelId, {
            at: Date.now(),
            exitId,
            kind: "server",
            reached: false,
            note,
          }, kind)
          return
        }
        state.markBlocked(exitId, `OpenCode refused this exit (HTTP ${code}).`)
        state.noteFailureContext(sessionID, modelId, {
          at: Date.now(),
          exitId,
          kind: "blocked",
          reached: true,
          note: `OpenCode refused this exit (HTTP ${code}).`,
        }, kind)
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
        }, kind)
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
        }, kind)
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
      }, kind)
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
      // Which exit the failure belongs to.
      //
      // The retry hook is told neither the request nor the answer, and a
      // session's title request runs beside its agent loop with the same
      // model. Only the agent loop's own marks can make an exit certain
      // enough to rest: a rest on a title's exit would keep a broken one in
      // use, and a rest on the loop's exit for a title's failure would bench
      // a working one. `context` (which still falls back across kinds) is
      // read only for what the failure *was* — it never decides which exit
      // is rested.
      const certainExit = state.primaryExitForRetry(sessionID, input.model.id)
      const context: FailureContext | undefined = state.failureFor(sessionID, input.model.id)
      // The exit the failure is blamed on when it is not certain: the agent
      // loop's note is the best guess, and a wrong guess only means the
      // retry does not rotate.
      const blamedExit = certainExit ?? state.relayedBy(sessionID, input.model.id)
      if (blamedExit === undefined) return
      const exit = state.exit(blamedExit)
      if (!exit) return
      if (input.attempt >= MAX_ROTATION_RETRIES) return

      const settings = state.settings()
      // Another attempt is worth asking for when another exit can serve, or
      // when the request may fall back to OpenCode itself. The bridge counts:
      // a proxy behind a bridge that is not running is not a way out, and a
      // retry would fail for a different reason than the one it was given.
      const canRetry = (): boolean =>
        state.canRetryAfterAllowance(bridge.ready) || settings.direct === "allow"

      const status = input.error.status
      if (status === undefined || status === 0) {
        // Nothing answered: the host was not found, the connection was refused,
        // TLS said no. The exit gets a rest, and another attempt may land on
        // one that works, or go direct when the user allows it. Without either,
        // the request hook would only replace the real error with a routing
        // failure, so the decision is left alone. The mark is taken before the
        // gate, so the exit that just failed cannot count as the way out.
        //
        // The rest is only taken when the exit is certain: a rest on the
        // wrong exit takes a working one out of use for the rest of the
        // session, which is worse than not resting any.
        if (certainExit !== undefined) {
          state.markFailure(certainExit, input.error.message ?? "The exit did not answer.", "unreachable")
        }
        if (!canRetry()) return
        input.decision = { retry: true, delay: ROTATE_DELAY_MS }
        return
      }

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
        // A relay that asked for another instance, a refusal that confirmed
        // the address is used up, or the local bridge answering for a proxy it
        // could not use is a reason to send the same request somewhere else.
        // The bridge's 409 says the exit is unavailable, not that the request
        // was wrong; a real upstream 409 through an exit carries reached: true
        // and is left alone.
        const bridgeRefusal = context?.kind === "server" && context.reached === false
        if (context?.kind !== "rotate" && context?.kind !== "exhausted" && !bridgeRefusal) return
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
        // retry that arrived without that context needs its single mark here,
        // and only when the exit is certain.
        if (context === undefined && certainExit !== undefined) {
          state.markFailure(certainExit, input.error.message ?? `HTTP ${status}`, "bad")
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

  // The pending announcement must not outlive the hooks: a timer that fires
  // after they are gone would announce to a registration that no longer
  // exists. Disposing the request hook stops it.
  const requestDispose = request.dispose
  return {
    request: {
      dispose: async () => {
        if (pending !== undefined) {
          clearTimeout(pending)
          pending = undefined
        }
        await requestDispose()
      },
    },
    response,
    retry,
  }
}
