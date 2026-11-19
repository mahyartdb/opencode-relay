/**
 * The checks that decide whether an exit can carry an OpenCode request.
 *
 * Three depths, because they answer three different questions:
 *
 * - `ping` asks the machinery whether it is alive, and (for a relay) which
 *   address it leaves from. It is cheap enough to run in the background.
 * - `api` asks OpenCode through the exit for its model list. It proves the exit
 *   can reach OpenCode, without spending the allowance a chat completion does.
 * - `deep` sends one tiny chat completion with the headers a real request had.
 *   It is the only check that can tell "OpenCode accepts this address" from
 *   "the address is used up", which is exactly what the user needs to know.
 *
 * A failed real request is not proof that the exit is spent: OpenCode also
 * refuses individual requests. The canary here asks again through the same
 * exit with a one-token request, and only a canary that is refused too retires
 * the exit.
 */
import {
  UPSTREAM_CHAT,
  UPSTREAM_MODELS,
  UPSTREAM_TRACE,
  egressAddress,
  nextResetAt,
  type ExitRecord,
  type ExitStatus,
  type ScanProgress,
} from "../lib/types.ts"
import {
  isFreeUsageLimit,
  parseRetryAfter,
  readBody,
  readResponseState,
  relayRequest,
  RELAY_ID_HEADER,
} from "../lib/routing.ts"
import { probeRelay } from "../lib/vercel.ts"
import { fetchThroughProxy } from "./bridge.ts"
import type { RelayState, RequestSample } from "./state.ts"

/** How often the background check looks at the exits. */
export const HEALTH_INTERVAL_MS = 10 * 60_000

/** How long a check may take before it is called a failure. */
const PING_TIMEOUT_MS = 15_000
/** Exported so a test that gates on a check can be exactly as patient as it. */
export const API_TIMEOUT_MS = 30_000
const DEEP_TIMEOUT_MS = 60_000
const CANARY_TIMEOUT_MS = 25_000

/** How long a free-limit verdict is trusted when the provider gives no reset. */
const EXHAUSTED_CAP_MS = 24 * 60 * 60_000

export type TestMode = "ping" | "api" | "deep"

/** What a check found. */
export interface TestResult {
  readonly ok: boolean
  readonly status: ExitStatus
  /** The HTTP status, or 0 when no answer arrived. */
  readonly code: number
  readonly ms: number
  readonly egress?: string
  readonly runtime?: string
  readonly note?: string
}

/** What the canary could prove. */
export type CanaryVerdict = "clean" | "spent" | "inconclusive"

/** The headers that describe one hop, never replayed from a sample. */
const NOT_REPLAYED = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "accept-encoding",
  "x-relay-target",
  "x-relay-path",
  "x-relay-key",
  "x-relay-avoid",
  "x-relay-control",
  RELAY_ID_HEADER,
  "x-bridge-exit",
  "x-bridge-target",
  "x-bridge-key",
])

/**
 * The headers an api check may carry.
 *
 * The api check runs on every exit on a timer, with nobody watching, so it
 * must not carry anything that could be a credential. A short allowlist is
 * the only way to be sure of that: a list of names to exclude breaks the
 * moment OpenCode sends a credential in a header nobody thought of.
 */
const API_HEADERS = new Set(["accept", "accept-language", "user-agent"])

/**
 * The headers of a captured request, without the ones that belong to one hop.
 *
 * The session token is only among them when the request needs one. The model
 * list is answered without a token, and the api check runs on every exit on
 * a timer: replaying the token there would hand the user's credentials to
 * whatever address an imported configuration named, without the user ever
 * asking for a check.
 */
function replayHeaders(sample: RequestSample | undefined, withCredentials: boolean): Headers {
  const headers = new Headers()
  if (!sample) return headers
  for (const [name, value] of Object.entries(sample.headers)) {
    const lower = name.toLowerCase()
    if (NOT_REPLAYED.has(lower)) continue
    if (!withCredentials && !API_HEADERS.has(lower)) continue
    headers.set(name, value)
  }
  return headers
}

/** One request, sent exactly the way the plugin sends a user's request. */
async function send(
  exit: ExitRecord,
  target: string,
  init: RequestInit,
): Promise<Response> {
  if (exit.kind === "relay") {
    const request = relayRequest(new Request(target, init), {
      url: exit.url,
      access: exit.access,
      id: exit.id,
    })
    return fetch(request)
  }
  return fetchThroughProxy(exit.url, target, init)
}

function timeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms)
}

/** The body of an answer, read from a copy so the caller still gets it whole. */
async function bodyOf(response: Response): Promise<string> {
  return (await readBody(response, 3000, 4000)) ?? ""
}

/** When a used-up exit is worth trying again. */
function resetFrom(headers: Headers, body: string): number {
  const now = Date.now()
  const header = parseRetryAfter(headers.get("retry-after"), now)
  if (header > 0) return now + Math.min(header, EXHAUSTED_CAP_MS)
  const json = /"retry_after"\s*:\s*(\d+)/i.exec(body)
  if (json) {
    const seconds = Number(json[1])
    if (Number.isFinite(seconds) && seconds > 0) {
      return now + Math.min(seconds * 1000, EXHAUSTED_CAP_MS)
    }
  }
  return nextResetAt(now)
}

/** Headers a relay or proxy test reports about itself. */
function exitHeaders(response: Response): { egress?: string; runtime?: string } {
  // The address goes into the avoid list that every relay receives, so it
  // only counts when it looks like an address.
  const egress = egressAddress(response.headers.get("x-relay-egress") ?? undefined)
  const runtime = response.headers.get("x-relay-runtime")
  return {
    ...(egress !== undefined ? { egress } : {}),
    ...(runtime !== null && runtime.length > 0 ? { runtime: runtime.slice(0, 64) } : {}),
  }
}

/** Read the verdict of one answer, without writing anything. */
interface Verdict {
  readonly status: ExitStatus
  readonly ok: boolean
  readonly code: number
  readonly until?: number
  readonly note?: string
}

/** The body of a chat answer, read from a copy, when it really is a model answer. */
async function modelAnswer(response: Response): Promise<boolean> {
  const text = await bodyOf(response)
  if (text.trim().length === 0) return false
  try {
    const data = JSON.parse(text) as { choices?: unknown }
    return Array.isArray(data.choices) && data.choices.length > 0
  } catch {
    return false
  }
}

async function judge(response: Response, deep = false): Promise<Verdict> {
  const code = response.status
  // A 409 only says the address is spent when the relay marks it as a rotation.
  // A bare 409 is the request's own conflict: another instance would answer it
  // the same way, so the exit is simply failing, not used up.
  if (code === 409 && response.headers.get("x-relay-rotate") === "1") {
    return {
      status: "exhausted",
      ok: false,
      code,
      until: nextResetAt(),
      note: "The address behind this exit is used up.",
    }
  }
  if (code === 429) {
    const body = await bodyOf(response)
    if (isFreeUsageLimit(body)) {
      return {
        status: "exhausted",
        ok: false,
        code,
        until: resetFrom(response.headers, body),
        note: "OpenCode says the free allowance of this address is used up.",
      }
    }
    return {
      status: "limited",
      ok: false,
      code,
      until: Date.now() + 60_000,
      note: "OpenCode rate-limited this exit.",
    }
  }
  if (code === 401 || code === 403) {
    return {
      status: "blocked",
      ok: false,
      code,
      note: `OpenCode refused this exit (HTTP ${code}).`,
    }
  }
  if (code >= 400) {
    return {
      status: "bad",
      ok: false,
      code,
      note: `The exit answered with HTTP ${code}.`,
    }
  }
  // A redirect or an empty answer is an intercepting proxy or an auth portal,
  // not OpenCode: nothing can be routed through it, whatever its 2xx says.
  if (code >= 300) {
    return {
      status: "bad",
      ok: false,
      code,
      note: `The exit redirected the request (HTTP ${code}).`,
    }
  }
  if (code < 200 || code === 204 || code === 205) {
    return {
      status: "bad",
      ok: false,
      code,
      note: `The exit answered without a model response (HTTP ${code}).`,
    }
  }
  // A 200 is not proof of a model answer: a captive portal or an HTML error
  // page answers 200 as well. Only the deep test can tell, so it asks whether
  // the answer really looks like a chat completion.
  if (deep && !(await modelAnswer(response))) {
    return {
      status: "bad",
      ok: false,
      code,
      note: "The exit answered, but not with a model response.",
    }
  }
  return { status: "ready", ok: true, code }
}

/** Everything the checks need from the world. */
export interface TesterDeps {
  readonly state: RelayState
  readonly announce: (reason: string) => Promise<void>
}

export class Tester {
  private timer: ReturnType<typeof setInterval> | undefined
  private running: Promise<void> | undefined
  private stopped = false

  constructor(private readonly deps: TesterDeps) {}

  /** Start the background check. Safe to call twice. */
  start(intervalMs = HEALTH_INTERVAL_MS): void {
    // A tester that was stopped is allowed to run again: without this, every
    // scan after a restart would silently do nothing.
    this.stopped = false
    if (this.timer !== undefined) return
    this.timer = setInterval(() => {
      const settings = this.deps.state.settings()
      if (!settings.enabled || !settings.healthChecks) return
      if (this.deps.state.exits().length === 0) return
      void this.scan("api")
    }, intervalMs)
    // A timer must not be the reason a process stays alive.
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  /** Stop the background check and let a running scan finish quietly. */
  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** Run one check and record what it found. */
  async test(id: string, mode: TestMode): Promise<TestResult> {
    const exit = this.deps.state.exit(id)
    if (!exit) {
      return { ok: false, status: "unknown", code: 0, ms: 0, note: "This exit is not there any more." }
    }
    if (mode === "ping") return this.ping(exit)
    if (mode === "deep") return this.deep(exit)
    return this.api(exit)
  }

  /** Is the machinery alive, and which address does it use? */
  private async ping(exit: ExitRecord): Promise<TestResult> {
    // The moment the probe started: a slower probe that finishes after a newer
    // verdict must not be taken for the newer one.
    const checkedAt = Date.now()
    const healthEpoch = this.deps.state.healthEpoch(exit.id)
    const started = performance.now()
    const elapsed = () => Math.max(0, Math.round(performance.now() - started))
    if (exit.kind === "relay") {
      const probe = await probeRelay(exit.url, exit.access)
      const status: ExitStatus = probe.reachable ? "reachable" : "unreachable"
      await this.record(exit.id, {
        status,
        latencyMs: probe.ms,
        ...(probe.egress !== undefined ? { egress: probe.egress } : {}),
        ...(probe.runtime !== undefined ? { runtime: probe.runtime } : {}),
        ...(probe.reachable ? {} : { lastError: "The relay did not answer." }),
        checkedAt,
        healthEpoch,
      })
      return {
        ok: probe.reachable,
        status,
        code: probe.status,
        ms: probe.ms,
        ...(probe.egress !== undefined ? { egress: probe.egress } : {}),
        ...(probe.runtime !== undefined ? { runtime: probe.runtime } : {}),
        ...(probe.reachable ? {} : { note: "The relay did not answer." }),
      }
    }
    const signal = timeout(PING_TIMEOUT_MS)
    try {
      const response = await fetchThroughProxy(exit.url, UPSTREAM_TRACE, { signal })
      // The trace answer is a handful of short lines; a captive portal that
      // answers with megabytes must not be read into memory whole, so the
      // read is capped like every other body this plugin reads.
      const text = (await readBody(response, 3000, 8000)) ?? ""
      const match = /^ip=(.+)$/m.exec(text)
      // The address goes into the avoid list that every relay receives, so
      // it has to be an address: anything else would travel to every relay
      // as a header, and one that is too long would make their requests
      // fail.
      const egress = egressAddress(match?.[1])
      // A 2xx alone is not proof: the trace endpoint answers in `ip=` lines,
      // so a proxy that returns anything else is not answering the ping.
      const ok = response.ok && /^ip=.+/m.test(text)
      const note = ok
        ? undefined
        : response.ok
          ? "The proxy answered with HTTP 200 but not with the expected trace."
          : `The proxy answered with HTTP ${response.status}.`
      await this.record(exit.id, {
        status: ok ? "reachable" : "unreachable",
        latencyMs: elapsed(),
        ...(egress !== undefined ? { egress } : {}),
        ...(note !== undefined ? { lastError: note } : {}),
        checkedAt,
        healthEpoch,
      })
      return {
        ok,
        status: ok ? "reachable" : "unreachable",
        code: response.status,
        ms: elapsed(),
        ...(egress !== undefined ? { egress } : {}),
        ...(note !== undefined ? { note } : {}),
      }
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error)
      // Nothing was learned about the exit: it simply did not answer. A rest
      // is the honest verdict, not a retirement that only another test
      // could lift.
      this.deps.state.markFailure(exit.id, note.slice(0, 240), "unreachable", healthEpoch)
      return { ok: false, status: "unreachable", code: 0, ms: elapsed(), note }
    }
  }

  /** Can OpenCode be reached through the exit? */
  private async api(exit: ExitRecord): Promise<TestResult> {
    return this.check(exit, "api")
  }

  /** Does a tiny real request work through the exit? */
  private async deep(exit: ExitRecord): Promise<TestResult> {
    return this.check(exit, "deep")
  }

  private async check(exit: ExitRecord, mode: "api" | "deep"): Promise<TestResult> {
    // A deep check carries the user's OpenCode session token, and a paused
    // exit is out of use on purpose: the token has no business going there.
    if (mode === "deep" && !exit.enabled) {
      return {
        ok: false,
        status: "unknown",
        code: 0,
        ms: 0,
        note: "This exit is paused, so it was not asked for a real request.",
      }
    }
    // When this check started, not when it ended: two overlapping checks may
    // finish out of order, and the older verdict must not overwrite the newer.
    const checkedAt = Date.now()
    // A live verdict between here and the answer makes this check stale, no
    // matter how recent its start looks on the record.
    const healthEpoch = this.deps.state.healthEpoch(exit.id)
    const started = performance.now()
    const elapsed = () => Math.max(0, Math.round(performance.now() - started))
    const sample = this.deps.state.requestSample()
    // The api check needs no session token, and must not send one: it runs on
    // every exit on a timer, and an exit the user never vetted would receive
    // the credentials. The deep check asks for a real completion, which only
    // answers for a request that carries them.
    const headers = replayHeaders(sample, mode === "deep")
    const signal = timeout(mode === "api" ? API_TIMEOUT_MS : DEEP_TIMEOUT_MS)
    let target = UPSTREAM_MODELS
    let init: RequestInit = { method: "GET", headers, signal }
    if (mode === "deep") {
      // The deep check replays a routed request's headers, and the session
      // token is among them. With no recent routed request there is nothing
      // to replay: the request would go out credential-less, OpenCode would
      // refuse it, and nothing would be learned. Saying so — and changing
      // nothing — is the honest answer.
      if (sample === undefined) {
        return {
          ok: false,
          status: "unknown",
          code: 0,
          ms: elapsed(),
          note: "No routed request has been captured in the last 30 minutes, so there are no headers to send. Route one request through any exit first, then run this check.",
        }
      }
      const model = sample.modelID
      target = UPSTREAM_CHAT
      const body = JSON.stringify({
        model,
        messages: [{ role: "user", content: "Say ok." }],
        max_tokens: 1,
        stream: false,
      })
      headers.set("content-type", "application/json")
      init = { method: "POST", headers, body, signal }
    }

    let response: Response
    try {
      response = await send(exit, target, init)
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error)
      // The exit never answered, so nothing was learned about it. A rest
      // (not a retirement) is the honest verdict: the exit is tried again
      // later, rather than staying out of use until a person tests it.
      this.deps.state.markFailure(exit.id, note.slice(0, 240), "unreachable", healthEpoch)
      return {
        ok: false,
        status: "unreachable",
        code: 0,
        ms: elapsed(),
        note: mode === "api" ? "OpenCode could not be reached through this exit." : note,
      }
    }
    let verdict = await judge(response, mode === "deep")
    /**
     * A refusal without credentials is the test's own doing.
     *
     * The deep check asks for a completion, which OpenCode only answers for
     * a request that carries the real headers. A deep test without a
     * captured request has nothing to imitate, so it goes out without the
     * authorization header, and a refusal then says nothing about the exit:
     * it would be the test that was refused. Recording it as "blocked" would
     * retire the exit until another test came, which is a verdict the check
     * never earned. The api check is not affected: the model list is answered
     * without a session token, so a refusal there is a real one.
     */
    const sentCredentials = headers.has("authorization") || headers.has("cookie")
    if (mode === "deep" && verdict.status === "blocked" && !sentCredentials) {
      verdict = {
        ...verdict,
        status: "unknown",
        ok: false,
        note:
          "OpenCode refused the test request, but it carried no credentials, so this says nothing about the exit.",
      }
    }
    /**
     * A refusal that never reached OpenCode is the relay's own.
     *
     * A relay with a wrong access token answers the request itself, and
     * OpenCode never sees it. The forwarded answers carry the relay's own
     * headers, so the difference is visible: blaming OpenCode for a refusal
     * the relay made sends the user after the wrong party.
     */
    if (verdict.status === "blocked" && exit.kind === "relay" && !readResponseState(response).reachedExit) {
      verdict = {
        ...verdict,
        status: "bad",
        ok: false,
        note: "The relay refused the plugin's access token.",
      }
    }
    const about = exitHeaders(response)
    const ms = elapsed()
    // An answered model list proves OpenCode is reachable, not that a model
    // request will work; only the deep test can say "ready". A check that does
    // not disprove the stronger verdict must not replace it either: an exit
    // that served a real request is still known to work.
    const proven = this.deps.state.exit(exit.id)?.status === "ready"
    const status =
      mode === "api" && verdict.status === "ready" && !proven ? "reachable" : verdict.status
    // A proxy's address is fixed, so a spent address means a spent proxy. A
    // relay can rotate to another instance, so only the address is remembered.
    const until = verdict.until
    const recorded = await this.record(exit.id, {
      status,
      latencyMs: ms,
      ...(about.egress !== undefined ? { egress: about.egress } : {}),
      ...(about.runtime !== undefined ? { runtime: about.runtime } : {}),
      ...(verdict.note !== undefined ? { lastError: verdict.note } : {}),
      ...(status === "exhausted" && until !== undefined ? { exhaustedUntil: until } : {}),
      checkedAt,
      healthEpoch,
    })
    // A stale check still reports what it saw, but it must not retire an exit
    // a newer check has already cleared, nor arm a cooldown from an old answer.
    if (recorded && status === "exhausted" && until !== undefined) {
      if (about.egress !== undefined) this.deps.state.markSpent(about.egress, until)
      else if (exit.egress !== undefined) this.deps.state.markSpent(exit.egress, until)
      this.deps.state.markExhausted(exit.id, until, verdict.note)
    } else if (recorded && status === "limited" && until !== undefined) {
      // A non-free 429 is a rest, not a retirement: the exit works again when
      // the cooldown passes, but it must not keep serving during it.
      this.deps.state.markRateLimited(exit.id, until, verdict.note)
    }
    return {
      ok: verdict.ok,
      status,
      code: verdict.code,
      ms,
      ...(about.egress !== undefined ? { egress: about.egress } : {}),
      ...(about.runtime !== undefined ? { runtime: about.runtime } : {}),
      ...(verdict.note !== undefined ? { note: verdict.note } : {}),
    }
  }

  /**
   * Ask again through the same exit, with the smallest request that can tell
   * a refused request from a spent address.
   *
   * The model list is not enough: it answers even when the chat allowance is
   * gone. The canary therefore sends a real, one-token completion. Without a
   * captured request there is no honest way to shape it, so the answer is
   * `inconclusive` rather than a guess.
   */
  async canary(exit: ExitRecord): Promise<CanaryVerdict> {
    const sample = this.deps.state.requestSample()
    if (sample === undefined) return "inconclusive"
    const headers = replayHeaders(sample, true)
    headers.set("content-type", "application/json")
    try {
      const response = await send(exit, UPSTREAM_CHAT, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: sample.modelID,
          messages: [{ role: "user", content: "Say ok." }],
          max_tokens: 1,
          stream: false,
        }),
        signal: timeout(CANARY_TIMEOUT_MS),
      })
      const about = exitHeaders(response)
      if (response.ok) {
        if (about.egress !== undefined && exit.egress !== undefined && about.egress !== exit.egress) {
          // A relay may have answered from another instance; that does not prove
          // the instance the real request used is clean.
          return "inconclusive"
        }
        return "clean"
      }
      if (response.status === 429) {
        const body = await bodyOf(response)
        return isFreeUsageLimit(body) ? "spent" : "inconclusive"
      }
      return "inconclusive"
    } catch {
      return "inconclusive"
    }
  }

  /** Check every exit, one after another, and say how far it has got. */
  scan(mode: TestMode = "api"): Promise<void> {
    if (this.running !== undefined) return this.running
    // A deep check carries the user's OpenCode session token, so it only
    // goes to the exits that are in use, and an imported exit is never
    // swept: only a test the user asked for by name may send to it. The
    // count says how many checks this run will really make.
    const exits = this.deps.state.exits()
    const total = exits.filter(
      (exit) => exit.imported !== true && (mode === "deep" ? exit.enabled : true),
    ).length
    if (total === 0) return Promise.resolve()
    this.running = this.runScan(mode, total).finally(() => {
      this.running = undefined
      this.deps.state.setScanning(undefined)
    })
    return this.running
  }

  private async runScan(mode: TestMode, initialTotal: number): Promise<void> {
    const startedAt = Date.now()
    // The total is the number of checks this run has to make. It only grows
    // when an exit is added while the run is going, so the fraction the pill
    // shows counts every check and not only the ones that are left.
    let total = initialTotal
    const progress: ScanProgress = {
      startedAt,
      total,
      done: 0,
      deep: mode === "deep",
    }
    let done = 0
    this.deps.state.setScanning(progress)
    // A list of fifty proxies must not take an hour, and hammering forty
    // endpoints at once is how a provider decides to block the user. Four at
    // a time keeps a long list moving without looking like an attack.
    //
    // A deep check carries the user's OpenCode session token, so it only goes
    // to the exits that are in use: a paused exit was put aside on purpose,
    // and the token has no business going there.
    //
    // An imported exit is left out of every sweep: its address came from a
    // shared file, and a check that promotes it would put the user's session
    // token on its way there. The user tests it themselves.
    const queue = this.deps.state
      .exits()
      .filter((exit) => (mode !== "deep" || exit.enabled) && exit.imported !== true)
    // An exit added while the scan runs (a paste finishing in the background,
    // a deploy landing mid-scan) must not sit untested because the queue was
    // copied once at the start: it is appended here, so the workers drain it
    // before they stop.
    const seen = new Set(queue.map((exit) => exit.id))
    const appended = (): void => {
      let added = 0
      for (const exit of this.deps.state.exits()) {
        if (seen.has(exit.id)) continue
        seen.add(exit.id)
        // A deep check carries the session token, so a paused exit is left
        // out of it as well.
        if (mode === "deep" && !exit.enabled) continue
        // An imported exit is left out of every sweep: its address came from
        // a shared file, and a check that promotes it would put the user's
        // session token on its way there.
        if (exit.imported === true) continue
        queue.push(exit)
        added += 1
      }
      if (added === 0) return
      total += added
      this.deps.state.setScanning({ startedAt, total, done, deep: mode === "deep" })
    }
    const worker = async (): Promise<void> => {
      for (;;) {
        const exit = queue.shift()
        if (exit === undefined) {
          // The queue ran dry, but an exit may have landed while the last
          // check ran. One re-check catches it; the workers stop together.
          appended()
          if (queue.length === 0 || this.stopped) return
          continue
        }
        if (this.stopped) return
        try {
          await this.test(exit.id, mode)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          this.deps.state.noteFailure(`${exit.name} could not be tested: ${message}`)
        }
        done += 1
        this.deps.state.setScanning({ startedAt, total, done, deep: mode === "deep" })
        void this.deps.announce("health changed").catch(() => {})
      }
    }
    const workers = Array.from({ length: Math.min(4, total) }, () => worker())
    await Promise.all(workers)
  }

  /**
   * Write a check's result into the record, without pretending a used-up exit
   * is ready.
   *
   * Returns false when the state already knows something newer (or the exit is
   * gone): an overlapping check that started later finished first, and this
   * result must not bring back a stale verdict or a cooldown.
   */
  private async record(
    id: string,
    update: {
      status: ExitStatus
      latencyMs?: number
      egress?: string
      runtime?: string
      lastError?: string
      exhaustedUntil?: number
      checkedAt?: number
      healthEpoch?: number
    },
  ): Promise<boolean> {
    // A check that fails must not erase the reset time of an exit that is known
    // to be spent, so the reset only travels with an exhausted status.
    if (update.status !== "exhausted") delete update.exhaustedUntil
    await this.deps.state.setHealth(id, update)
    if (update.checkedAt === undefined) return true
    const exit = this.deps.state.exit(id)
    return (
      exit?.lastCheck === update.checkedAt &&
      (update.healthEpoch === undefined ||
        update.healthEpoch === this.deps.state.healthEpoch(id))
    )
  }
}
