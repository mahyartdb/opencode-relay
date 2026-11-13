/**
 * What the terminal UI says, without the terminal.
 *
 * The menu entries, the pages and the footer line are pure functions of the
 * status the server reports. Keeping them here means they can be tested
 * without a renderer, and the dialogs only have to run the flows.
 *
 * Relays and proxies are shown as one list of *exits*, because that is how
 * routing treats them: either can carry a request, and the strategy picks
 * among both.
 */
import type { DialogSelectOption } from "@opencode/plugin/tui/context"
import { STRATEGY_LABELS, resetTime } from "../lib/types.ts"

/** What the main menu can do. */
export type MenuAction =
  | "status"
  | "preview"
  | "toggle"
  | "models"
  | "exits"
  | "settings"
  | "close"

/** One exit in a list, with the id the action needs. */
export type ExitChoice = {
  readonly id: string
  readonly name: string
  readonly kind: "relay" | "proxy"
  /** True only when this plugin deployed the relay, so there is a project to push code to. */
  readonly deployed?: boolean
}

/** The shape of an exit in a list, without the whole contract. */
export interface ExitSummaryLike {
  readonly id: string
  readonly kind: "relay" | "proxy"
  readonly name: string
  readonly status: string
  readonly statusLabel: string
  readonly enabled: boolean
  readonly url: string
  readonly region?: string
  readonly regionLabel?: string
  readonly project?: string
  readonly latencyMs?: number
  readonly exhaustedUntil?: number
  readonly lastError?: string
  /** The address the exit last reported it leaves from. */
  readonly egress?: string
  /** The runtime the exit reported, when it says. */
  readonly runtime?: string
  /** When the last check ran. */
  readonly lastCheck?: number
  /** When the exit was added. */
  readonly createdAt?: number
  /** How many requests have gone through this exit, when the status carried them. */
  readonly stats?: {
    readonly requests: number
    readonly ok?: number
    readonly rotated?: number
    readonly limited?: number
    readonly failed?: number
    readonly lastMs?: number
    readonly averageMs?: number
  }
}

/** The part of the status the menus, the pages and the pill read. */
export interface StatusLike {
  readonly enabled: boolean
  readonly selection: "free" | "custom"
  readonly strategy: "fixed" | "round-robin" | "exhausted" | "fastest"
  readonly direct: "allow" | "never"
  /** Whether exits are checked automatically in the background. */
  readonly healthChecks?: boolean
  readonly customModels: readonly string[]
  readonly activeExit?: {
    readonly id: string
    readonly name: string
    readonly kind?: "relay" | "proxy"
    readonly status?: string
  }
  readonly exits: readonly ExitSummaryLike[]
  readonly accounts: readonly { readonly name: string }[]
  readonly exhausted: readonly string[]
  readonly paused?: readonly string[]
  /** Exits that are skipped because they did not answer or are cooling down. */
  readonly skipped?: readonly string[]
  /**
   * The exit the server's picker would use for the next request, with the live
   * cooldown state applied. Absent when no exit can serve, and from a server
   * that predates the field.
   */
  readonly servingExitId?: string
  /**
   * The exits the server's picker would leave out right now. Unlike `skipped`,
   * this also holds paused, used-up and untested exits, so it is the picker's
   * whole answer rather than only the cooldown list.
   */
  readonly skippedExitIds?: readonly string[]
  readonly routedCount: number
  readonly modelCount: number
  /** What the last request's routing decision was, when one was recorded. */
  readonly lastDecision?: {
    readonly modelId: string
    readonly routed: boolean
    readonly reason: string
    readonly exitName?: string
    readonly kind?: string
    readonly at?: number
  }
  /** A background test run in progress, if any. */
  readonly scanning?: {
    readonly startedAt: number
    readonly total: number
    readonly done: number
    readonly kind?: string
    readonly deep?: boolean
  }
  /** The last routing note, e.g. why a request went direct. */
  readonly note?: string
}

/** The fallback words for a status. The server's own label is preferred; this only fills a gap. */
const STATUS_LABELS: Record<string, string> = {
  untested: "not tested",
  ready: "ready",
  reachable: "reachable, not model-tested",
  limited: "rate limited",
  exhausted: "used up",
  blocked: "blocked by OpenCode",
  unreachable: "not answering",
  bad: "failing",
  unknown: "not tested",
}

/** The label for a status, whatever spelling the record used. */
export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status
}

/** The status of an exit in words, preferring what the server said. */
function exitStatusWord(exit: ExitSummaryLike): string {
  return (exit.statusLabel ?? "").length > 0 ? exit.statusLabel : statusLabel(exit.status)
}

/** Whether one exit is the one routing would use right now.
 *
 * The live cooldown map lives in the server process and never crosses the RPC,
 * so the TUI cannot replay the picker's rule. The status carries the picker's
 * answer instead: the id it would serve and the ids it would skip. When either
 * is present it is the truth, even where it contradicts a raw status verdict —
 * a blocked exit whose rest has expired serves again, and an untested one does
 * not serve at all. A status from an older server carries neither, so the old
 * status-based predicate is the best available fallback there.
 */
export function isUsableExit(exit: ExitSummaryLike, status: StatusLike): boolean {
  if (!exit.enabled) return false
  // The picker names the one exit that would serve; every other exit, however
  // healthy its record looks, would not carry the next request.
  if (status.servingExitId !== undefined) return status.servingExitId === exit.id
  // No serving exit but a skip list: this server reports the picker, and it
  // found nothing it could serve.
  if (status.skippedExitIds !== undefined) return !status.skippedExitIds.includes(exit.id)
  // An older server reported neither, so fall back to what the status allows.
  return (
    !status.exhausted.includes(exit.id) &&
    !(status.skipped ?? []).includes(exit.id) &&
    exit.status !== "unreachable" &&
    exit.status !== "blocked" &&
    exit.status !== "bad"
  )
}

/** The exits that are neither paused nor out of use right now. */
export function usableExits(status: StatusLike): readonly ExitSummaryLike[] {
  return status.exits.filter((exit) => isUsableExit(exit, status))
}

/** The name routing points at, when one exit can be named. */
function routingName(status: StatusLike): string {
  if (status.strategy === "round-robin") return "round robin"
  if (status.strategy === "fastest") return "fastest"
  // The picker's answer is the only name that is always true: the chosen exit
  // may be paused, used up or cooling while a backup takes the request, and
  // only the server knows which one that is.
  if (status.servingExitId !== undefined) {
    const serving = status.exits.find((item) => item.id === status.servingExitId)
    return serving?.name ?? "next exit"
  }
  // A server that reports the picker but no serving exit is saying that
  // nothing will carry the next request.
  if (status.skippedExitIds !== undefined) return "next exit"
  const active = status.activeExit
  if (active === undefined) return "next exit"
  // Only an exit routing would actually use may be named. A chosen exit that
  // is paused, used up, or cooling after a failure leaves the name open: the
  // next usable exit takes the request.
  const exit = status.exits.find((item) => item.id === active.id)
  if (exit === undefined || !isUsableExit(exit, status)) return "next exit"
  return active.name
}

/** The exit the status says routing would use, when it can say. */
function pickerChoice(status: StatusLike): string | undefined {
  if (status.servingExitId !== undefined) return status.servingExitId
  // A new server with no serving exit is saying that nothing serves, so a
  // chosen exit that cannot serve must not be marked as if it would.
  if (status.skippedExitIds !== undefined) return undefined
  return status.activeExit?.id
}

/** Whether the picker leaves the exit out for a reason the line does not already show. */
function pickerSkippedSilently(exit: ExitSummaryLike, status: StatusLike): boolean {
  if (!(status.skippedExitIds ?? []).includes(exit.id)) return false
  if (!exit.enabled) return false
  if (status.exhausted.includes(exit.id)) return false
  if ((status.skipped ?? []).includes(exit.id)) return false
  const word = exitStatusWord(exit).toLowerCase()
  return !/not tested|not answering|used up|rate limited|blocked|failing/.test(word)
}

/** How many requests have gone through an exit. */
function trafficCount(status: StatusLike): number {
  return status.exits.reduce((sum, exit) => sum + (exit.stats?.requests ?? 0), 0)
}

/** The suffix that counts used-up exits, or an empty string. */
function usedUpNote(status: StatusLike): string {
  const used = status.exhausted.length
  return used > 0 ? ` · ${used} used up` : ""
}

/** What the main menu says about routing right now. */
export function describeStatusSummary(status: StatusLike): string {
  // A test run in progress is the most current fact, so it comes before the
  // off line and before the counts: it keeps showing while routing is off.
  const scanning = status.scanning
  const busy = scanning !== undefined && scanning.done < scanning.total
  if (busy) {
    return status.enabled
      ? `Testing ${scanning.done}/${scanning.total}`
      : `Off · testing ${scanning.done}/${scanning.total}`
  }
  if (!status.enabled) {
    if (status.exits.length === 0) return "Off · no exits"
    return `Off · ${status.exits.length} exit${status.exits.length === 1 ? "" : "s"}`
  }
  // Routing on, but nothing selected survives the free-model filter: saying
  // which exit would take a request would promise routing that cannot happen.
  if (status.selection === "custom" && status.routedCount === 0) return "On · nothing routed"
  const usable = usableExits(status).length
  if (usable === 0) {
    return status.direct === "never"
      ? "On · no exit can serve · fail"
      : "On · no exit can serve · direct"
  }
  return `On · ${routingName(status)} · ${trafficCount(status)} req${usedUpNote(status)}`
}

/** What the menu says about the current selection. */
export function describeSelection(status: StatusLike): string {
  if (status.selection === "free") {
    return `Every free model · ${status.routedCount} routed of ${status.modelCount}`
  }
  // The routed count, not the raw list: the list still holds models that
  // were dropped because they are not free.
  const count = status.routedCount
  if (count === 0) return "No model chosen · nothing is routed"
  return `${count} chosen free model${count === 1 ? "" : "s"}`
}

/** What the Settings entry says in one line. */
export function describeSettings(status: StatusLike): string {
  const strategies: Record<StatusLike["strategy"], string> = {
    fixed: "one exit",
    "round-robin": "round robin",
    exhausted: "until exhausted",
    fastest: "fastest",
  }
  const direct = status.direct === "allow" ? "direct fallback" : "no direct fallback"
  const checks = status.healthChecks !== false ? "checks on" : "checks off"
  return `${strategies[status.strategy]} · ${direct} · ${checks}`
}

/** What the Settings entry about the strategy says. */
export function describeStrategy(status: StatusLike): string {
  return `Now: ${STRATEGY_LABELS[status.strategy].title}`
}

/** The main menu: a few categorized hubs, and nothing that would do nothing.
 *
 * No descriptions: the host draws an option's title and description on one
 * line and clips the tail, so a description only ever read as a truncated
 * sentence. The state each hub would have described lives on its own page,
 * in the exit list, and in the footer pill.
 */
export function menuOptions(status: StatusLike): DialogSelectOption<MenuAction>[] {
  return [
    { title: "Status", value: "status", category: "Routing" },
    { title: "Preview the next request", value: "preview", category: "Routing" },
    {
      title: status.enabled ? "Turn routing off" : "Turn routing on",
      value: "toggle",
      category: "Routing",
    },
    { title: "Models", value: "models", category: "Routing" },
    { title: "Exits", value: "exits", category: "Exits" },
    { title: "Settings", value: "settings", category: "Settings" },
    { title: "Close", value: "close" },
  ]
}

/** The most an exit line may take in a dialog, where the host clips the tail. */
const EXIT_LINE_MAX = 40

/** The pieces of an exit line, and how easily each may be left out. */
type ExitFact = { readonly text: string; readonly rank: number }

/**
 * One line that describes an exit, wherever it is shown.
 *
 * Only compact facts: state, latency, traffic and the chosen mark. The name
 * is the entry's own title and a deployed relay's name already carries its
 * region, so repeating either here is what the dialog clips. The kind, the
 * region and everything else live on the Details page.
 *
 * The line is capped at `max` characters: the host draws it on the same line
 * as the name and clips the tail, so a long line only ever read as a cut
 * word. When the facts do not fit, the least useful one steps aside first
 * (latency, then traffic, then a redundant marker) and the state never does.
 */
export function describeExit(
  exit: ExitSummaryLike,
  status: StatusLike,
  max: number = EXIT_LINE_MAX,
): string {
  const word = exitStatusWord(exit)
  const skipped = (status.skipped ?? []).includes(exit.id)
  const facts: ExitFact[] = []
  if (!exit.enabled) facts.push({ text: "paused", rank: 6 })
  if (skipped && !word.includes("not answering")) facts.push({ text: "not answering", rank: 5 })
  if (status.exhausted.includes(exit.id) && !word.includes("used up")) {
    facts.push({ text: "used up", rank: 5 })
  }
  facts.push({ text: word, rank: 7 })
  if (exit.latencyMs !== undefined) facts.push({ text: `${exit.latencyMs} ms`, rank: 2 })
  // The traffic this exit has carried, which is what the user wants to see
  // next to a name. The count of selected models is not traffic and is never
  // shown here.
  facts.push({ text: `${exit.stats?.requests ?? 0} req`, rank: 3 })
  const chosen = pickerChoice(status)
  if (chosen === exit.id) facts.push({ text: "chosen", rank: 6 })

  const kept = new Set<ExitFact>()
  let used = 0
  const byRank = [...facts].sort((a, b) => b.rank - a.rank)
  for (const [index, fact] of byRank.entries()) {
    const next = used === 0 ? fact.text.length : used + 3 + fact.text.length
    // The highest-ranked fact - the status word - is always kept, even over
    // the budget: a line without a state would say nothing at all.
    if (index > 0 && next > max) continue
    kept.add(fact)
    used = next
  }
  return facts
    .filter((fact) => kept.has(fact))
    .map((fact) => fact.text)
    .join(" · ")
}

/**
 * The list of exits, in the shape the menus show them.
 *
 * A relay that is used up, and the one the user chose, are marked here rather
 * than in the dialog, so the marks are testable and the same wherever a list
 * of exits is shown. Each value also says whether this plugin deployed the
 * relay, because only such a relay has a project to push code to.
 *
 * No footer: the host squeezes a footer line until titles read "Rel" or
 * "127", and the last error is already shown on the Details page.
 */
export function exitList(status: StatusLike): DialogSelectOption<ExitChoice>[] {
  return status.exits.map((exit) => ({
    title: exit.name,
    value: {
      id: exit.id,
      name: exit.name,
      kind: exit.kind,
      deployed: exit.kind === "relay" && (exit.project ?? "").length > 0,
    },
    description: describeExit(exit, status),
  }))
}

/** What the Exits submenu can do: one exit, or one of the list-level moves. */
export type ExitListAction =
  | ExitChoice
  | { readonly kind: "add" }
  | { readonly kind: "back" }
  | { readonly kind: "test-all" }
  | { readonly kind: "update-all" }
  | { readonly kind: "restore" }

/** The Exits submenu: every exit, then the list-level moves, then Back.
 *
 * Descriptions stay short on purpose: the host renders them on the same line
 * as the title and clips the tail, so anything long reads as a cut word.
 */
export function exitsMenuOptions(status: StatusLike): DialogSelectOption<ExitListAction>[] {
  const options: DialogSelectOption<ExitListAction>[] = [...exitList(status)]
  if (status.exits.length > 0) {
    const count = status.exits.length
    options.push({
      title: "Test all exits",
      value: { kind: "test-all" },
      description: `${count} exit${count === 1 ? "" : "s"} - checks OpenCode through each`,
    })
  }
  if (status.exits.some((exit) => exit.kind === "relay" && (exit.project ?? "").length > 0)) {
    options.push({
      title: "Update all relays",
      value: { kind: "update-all" },
      description: "Redeploy the current code to each relay",
    })
  }
  if (status.exhausted.length > 0) {
    options.push({
      title: "Bring used-up exits back",
      value: { kind: "restore" },
      description: `${status.exhausted.length} exit${status.exhausted.length === 1 ? " is" : "s are"} out of use`,
    })
  }
  options.push({
    title: "Add exits",
    value: { kind: "add" },
    description: "Deploy a relay, track one, paste proxies",
  })
  options.push({ title: "Back", value: { kind: "back" } })
  return options
}

/** The shape of a routing preview, without the whole contract. */
export interface PreviewLike {
  readonly modelId?: string
  readonly providerID?: string
  readonly routed: boolean
  readonly reason: string
  readonly direct: "allow" | "never"
  readonly exit?: { readonly name?: string }
  readonly skipped: readonly { readonly name: string; readonly reason: string }[]
}

/** The read-only page about where the next request would go. */
export function describePreview(preview: PreviewLike): string {
  const lines: string[] = []
  if (preview.modelId !== undefined && preview.modelId.length > 0) {
    lines.push(
      `Model: ${preview.modelId}${preview.providerID ? ` (${preview.providerID})` : ""}`,
    )
  }
  lines.push(
    preview.routed && preview.exit?.name
      ? `Routed through ${preview.exit.name}`
      : "Not routed",
  )
  lines.push(preview.reason)
  lines.push(
    preview.direct === "never"
      ? "If no exit can serve: fail"
      : "If no exit can serve: go direct",
  )
  if (preview.skipped.length > 0) {
    lines.push("", "Left out:")
    for (const exit of preview.skipped) lines.push(`  ${exit.name}: ${exit.reason}`)
  }
  return lines.join("\n")
}

/** The first sentence of a text, in the form a line comparison can match. */
function firstSentence(text: string): string {
  const stop = text.search(/[.!?]/)
  const sentence = stop === -1 ? text : text.slice(0, stop + 1)
  return sentence.replace(/\s+/g, " ").trim().toLowerCase()
}

/**
 * Whether a note would only say again what a line above it already said.
 *
 * The server's routing-off note is this page's own first line, so printing
 * both said the same thing twice. Only a note whose first sentence matches an
 * already-printed line is dropped; every other note is kept.
 */
function repeatsPrintedLine(note: string, lines: readonly string[]): boolean {
  const key = firstSentence(note)
  if (key.length === 0) return false
  return lines.some((line) => firstSentence(line) === key)
}

/** The read-only page about everything the plugin knows right now. */
export function describeStatusPage(status: StatusLike): string {
  const lines: string[] = []
  lines.push(
    status.enabled
      ? "Routing is on."
      : "Routing is off: requests go straight to OpenCode.",
  )
  if (status.selection === "free") {
    lines.push(`Models: every free model - ${status.routedCount} routed of ${status.modelCount}`)
  } else if (status.routedCount === 0) {
    lines.push("Models: no model chosen - nothing is routed")
  } else {
    const count = status.routedCount
    lines.push(`Models: ${count} chosen free model${count === 1 ? "" : "s"}`)
  }
  lines.push(`Strategy: ${STRATEGY_LABELS[status.strategy].title}`)
  lines.push(
    status.direct === "allow"
      ? "When no exit can serve: go direct"
      : "When no exit can serve: fail instead of going direct",
  )
  lines.push(
    status.healthChecks !== false
      ? "Background checks: on, every 10 minutes"
      : "Background checks: off, only when you ask",
  )

  const traffic = trafficCount(status)
  if (traffic === 0) {
    lines.push("No request has gone through an exit yet.")
  } else {
    const ok = status.exits.reduce((sum, exit) => sum + (exit.stats?.ok ?? 0), 0)
    const rotated = status.exits.reduce((sum, exit) => sum + (exit.stats?.rotated ?? 0), 0)
    const limited = status.exits.reduce((sum, exit) => sum + (exit.stats?.limited ?? 0), 0)
    const failed = status.exits.reduce((sum, exit) => sum + (exit.stats?.failed ?? 0), 0)
    lines.push(
      `${traffic} request${traffic === 1 ? "" : "s"} through exits (${ok} ok, ${rotated} rotated, ${limited} limited, ${failed} failed).`,
    )
  }

  lines.push("", `Exits: ${status.exits.length}`)
  for (const exit of status.exits) {
    // The page has room for every fact; the dialog line next to a name does not.
    const skipped = pickerSkippedSilently(exit, status) ? " · skipped" : ""
    lines.push(`  ${exit.name}: ${describeExit(exit, status, 160)}${skipped}`)
    if (exit.exhaustedUntil !== undefined && !exitStatusWord(exit).includes("used up until")) {
      lines.push(`    used up until ${resetTime(exit.exhaustedUntil)}`)
    }
  }

  const decision = status.lastDecision
  if (decision) {
    const what =
      decision.routed && decision.exitName
        ? `routed through ${decision.exitName}`
        : decision.reason
    lines.push(`Last request: ${decision.modelId} - ${what}`)
  } else {
    lines.push("Last request: none yet.")
  }

  const note = status.note
  if (note !== undefined && note.length > 0 && !repeatsPrintedLine(note, lines)) {
    lines.push("", note)
  }

  const scanning = status.scanning
  if (scanning && scanning.done < scanning.total) {
    lines.push("", `Testing: ${scanning.done} of ${scanning.total} exits checked.`)
  }
  return lines.join("\n")
}

/** The read-only page about one exit: address, health, traffic, last error. */
export function describeExitDetails(exit: ExitSummaryLike, status: StatusLike): string {
  const lines: string[] = []
  lines.push(`Name: ${exit.name}`)
  lines.push(`Kind: ${exit.kind}`)
  lines.push(`Address: ${exit.url}`)
  // The Vercel project this plugin deployed: removing the exit offers to
  // remove the project with it, and this line is where that name comes from.
  if ((exit.project ?? "").length > 0) lines.push(`Project: ${exit.project}`)
  lines.push(`Status: ${exitStatusWord(exit)}`)
  // The same answer the list marks "chosen": the picker's serving exit when the
  // server reports it, and the stored choice on an older server that does not.
  lines.push(pickerChoice(status) === exit.id ? "Chosen exit." : "Not the chosen exit.")
  lines.push(exit.enabled ? "In use." : "Paused: kept, but not used.")
  if (exit.exhaustedUntil !== undefined) {
    lines.push(`Used up until ${resetTime(exit.exhaustedUntil)}.`)
  }
  if (exit.latencyMs !== undefined) lines.push(`Latency: ${exit.latencyMs} ms`)
  if (exit.egress !== undefined && exit.egress.length > 0) {
    lines.push(`Leaves from: ${exit.egress}`)
  }
  if (exit.runtime !== undefined && exit.runtime.length > 0) {
    lines.push(`Runtime: ${exit.runtime}`)
  }
  if (exit.lastCheck !== undefined) lines.push(`Last check: ${resetTime(exit.lastCheck)}`)
  const stats = exit.stats
  if (stats) {
    const parts = [
      `total ${stats.requests}`,
      `${stats.ok ?? 0} ok`,
      `${stats.rotated ?? 0} rotated`,
      `${stats.limited ?? 0} limited`,
      `${stats.failed ?? 0} failed`,
    ]
    lines.push("", `Requests: ${parts.join(", ")}`)
    if (stats.lastMs !== undefined) lines.push(`Last round trip: ${stats.lastMs} ms`)
    if (stats.averageMs !== undefined) lines.push(`Average round trip: ${stats.averageMs} ms`)
  }
  if (exit.lastError !== undefined && exit.lastError.length > 0) {
    lines.push("", `Last error: ${exit.lastError}`)
  }
  return lines.join("\n")
}

/** The tone of the footer pill, in the words a theme speaks. */
export type PillTone = "off" | "ok" | "warn" | "bad" | "busy"

/** How the pill should be colored, so a problem is visible without reading. */
export function pillTone(status: StatusLike | undefined): PillTone {
  if (!status) return "off"
  // A test run reads as busy even while routing is off: the scan is what is
  // happening right now, whatever the switch says.
  const scanning = status.scanning
  if (scanning !== undefined && scanning.done < scanning.total) return "busy"
  if (!status.enabled) return "off"
  if (status.exits.length === 0) return "warn"
  const usable = usableExits(status).length
  if (usable === 0) return status.direct === "never" ? "bad" : "warn"
  if (status.exhausted.length > 0) return "warn"
  return "ok"
}

/** The line the footer shows, or undefined when there is nothing worth saying. */
export function summarizePill(status: StatusLike | undefined): string | undefined {
  if (!status) return undefined
  // A background test is the most current fact, so it comes first: it keeps
  // showing while routing is off and before the first exit exists.
  const scanning = status.scanning
  if (scanning !== undefined && scanning.done < scanning.total) {
    const progress = `testing ${scanning.done}/${scanning.total}`
    return status.enabled ? `relay on · ${progress}` : `relay off · ${progress} · /relay`
  }
  if (!status.enabled) {
    // The pill is how someone finds the menu again, so it always shows once
    // the plugin exists - even before the first exit.
    return "relay off · /relay"
  }
  if (status.exits.length === 0) return "relay on · no exits · /relay"
  // Routing is on, but a custom selection leaves nothing for the router to
  // send: naming an exit now would promise routing that cannot happen.
  if (status.selection === "custom" && status.routedCount === 0) return "relay on · nothing routed"
  const usable = usableExits(status).length
  if (usable === 0) {
    return status.direct === "never"
      ? "relay on · no exit can serve · fail"
      : "relay on · no exit can serve · direct"
  }
  // The pill reports traffic: how many requests went through an exit. How
  // many models are selected is not how many requests went anywhere, and
  // showing it here would read as traffic when none has happened.
  const traffic = trafficCount(status)
  return `relay · ${routingName(status)} · ${traffic} req${usedUpNote(status)}`
}
