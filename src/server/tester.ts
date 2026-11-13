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
  nextResetAt,
  type ExitRecord,
  type ExitStatus,
  type ScanProgress,
} from "../lib/types.ts"
import {
  isFreeUsageLimit,
  parseRetryAfter,
  readBody,
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

/** The headers of a captured request, without the ones that belong to one hop. */
function replayHeaders(sample: RequestSample | undefined): Headers {
  const headers = new Headers()
  if (!sample) return headers
  for (const [name, value] of Object.entries(sample.headers)) {
    if (NOT_REPLAYED.has(name.toLowerCase())) continue
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
  const egress = response.headers.get("x-relay-egress")
  const runtime = response.headers.get("x-relay-runtime")
  return {
    ...(egress !== null && egress.length > 0 ? { egress } : {}),
    ...(runtime !== null && runtime.length > 0 ? { runtime } : {}),
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
  if (code < 200 || code === 204) {
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

/** The name a proxy gets when the user did not give one. */
export function proxyName(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.hostname
  } catch {
    return "proxy"
  }
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
      const text = response.ok ? await response.text() : ""
      const match = /^ip=(.+)$/m.exec(text)
      const egress = match?.[1]?.trim()
      const ok = response.ok
      await this.record(exit.id, {
        status: ok ? "reachable" : "unreachable",
        latencyMs: elapsed(),
        ...(egress !== undefined ? { egress } : {}),
        ...(ok ? {} : { lastError: `The proxy answered with HTTP ${response.status}.` }),
        checkedAt,
        healthEpoch,
      })
      return {
        ok,
        status: ok ? "reachable" : "unreachable",
        code: response.status,
        ms: elapsed(),
        ...(egress !== undefined ? { egress } : {}),
        ...(ok ? {} : { note: `The proxy answered with HTTP ${response.status}.` }),
      }
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error)
      await this.record(exit.id, {
        status: "unreachable",
        latencyMs: elapsed(),
        lastError: note.slice(0, 240),
        checkedAt,
        healthEpoch,
      })
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
    // When this check started, not when it ended: two overlapping checks may
    // finish out of order, and the older verdict must not overwrite the newer.
    const checkedAt = Date.now()
    // A live verdict between here and the answer makes this check stale, no
    // matter how recent its start looks on the record.
    const healthEpoch = this.deps.state.healthEpoch(exit.id)
    const started = performance.now()
    const elapsed = () => Math.max(0, Math.round(performance.now() - started))
    const sample = this.deps.state.requestSample()
    const headers = replayHeaders(sample)
    const signal = timeout(mode === "api" ? API_TIMEOUT_MS : DEEP_TIMEOUT_MS)
    let target = UPSTREAM_MODELS
    let init: RequestInit = { method: "GET", headers, signal }
    if (mode === "deep") {
      const model = sample?.modelID ?? (await this.pickModel(exit, signal))
      if (model === undefined) {
        const result: TestResult = {
          ok: false,
          status: "bad",
          code: 0,
          ms: elapsed(),
          note: "No model could be read to test with.",
        }
        await this.record(exit.id, {
          status: result.status,
          latencyMs: result.ms,
          lastError: result.note,
          checkedAt,
          healthEpoch,
        })
        return result
      }
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
      await this.record(exit.id, {
        status: "unreachable",
        latencyMs: elapsed(),
        lastError: note.slice(0, 240),
        checkedAt,
        healthEpoch,
      })
      return {
        ok: false,
        status: "unreachable",
        code: 0,
        ms: elapsed(),
        note: mode === "api" ? "OpenCode could not be reached through this exit." : note,
      }
    }
    const verdict = await judge(response, mode === "deep")
    const about = exitHeaders(response)
    const ms = elapsed()
    // An answered model list proves OpenCode is reachable, not that a model
    // request will work; only the deep test can say "ready".
    const status = mode === "api" && verdict.status === "ready" ? "reachable" : verdict.status
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

  /** The first model OpenCode lists through the exit. */
  private async pickModel(exit: ExitRecord, signal: AbortSignal): Promise<string | undefined> {
    try {
      const response = await send(exit, UPSTREAM_MODELS, {
        method: "GET",
        headers: replayHeaders(undefined),
        signal,
      })
      if (!response.ok) return undefined
      const data = (await response.json()) as { data?: Array<{ id?: unknown }> }
      const first = data.data?.find((entry) => typeof entry.id === "string")
      return typeof first?.id === "string" ? first.id : undefined
    } catch {
      return undefined
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
    const headers = replayHeaders(sample)
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
    const total = this.deps.state.exits().length
    if (total === 0) return Promise.resolve()
    this.running = this.runScan(mode, total).finally(() => {
      this.running = undefined
      this.deps.state.setScanning(undefined)
    })
    return this.running
  }

  private async runScan(mode: TestMode, total: number): Promise<void> {
    const startedAt = Date.now()
    const progress: ScanProgress = {
      startedAt,
      total,
      done: 0,
      deep: mode === "deep",
    }
    let done = 0
    this.deps.state.setScanning(progress)
    // A list of fifty proxies must not take an hour, and hammering forty
    // endpoints at once is how a provider decides to block the user. Four at a
    // time keeps a long list moving without looking like an attack.
    const queue = [...this.deps.state.exits()]
    const worker = async (): Promise<void> => {
      for (;;) {
        const exit = queue.shift()
        if (exit === undefined || this.stopped) return
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

/** One line for a test result, so every surface says it the same way. */
export function describeTest(result: TestResult): string {
  if (result.ok) {
    return result.status === "reachable"
      ? `Reachable in ${result.ms} ms, but no model request was tried.`
      : `Ready: a model request worked (${result.ms} ms).`
  }
  const code = result.code > 0 ? ` (HTTP ${result.code})` : ""
  return (result.note ?? "The test failed.") + code
}
