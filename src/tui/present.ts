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
  /** The Vercel account this relay was deployed with, when it has one. */
  readonly accountId?: string
  readonly latencyMs?: number
  readonly exhaustedUntil?: number
  /** Why OpenCode said the address is used up, when it said. */
  readonly spendReason?: string
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
  readonly accounts: readonly { readonly name: string; readonly id?: string }[]
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
  /**
   * Whether a routed request has been captured in the last 30 minutes.
   *
   * The deep test replays the captured headers, and the session token is
   * among them: without one, the check would be refused on credentials that
   * were never carried. A status from an older server says nothing, which
   * the deep rows treat as "unknown".
   */
  readonly hasRequestSample?: boolean
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
 *
 * Routing off means no exit is used, whatever the picker would say: the server
 * still computes the pick, but no request ever leaves through one.
 */
export function isUsableExit(exit: ExitSummaryLike, status: StatusLike): boolean {
  if (!exit.enabled) return false
  if (!status.enabled) return false
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
  // Routing off means no exit serves, whatever the picker would compute.
  if (!status.enabled) return undefined
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

/**
 * The suffix that counts used-up exits, or an empty string.
 *
 * An exit the user paused is not a problem to look at: it is out of use on
 * purpose, and counting it would keep the pill in the warning color over
 * something the user chose.
 */
function usedUpNote(status: StatusLike): string {
  const used = status.exhausted.filter((id) => {
    const exit = status.exits.find((item) => item.id === id)
    return exit === undefined || exit.enabled
  }).length
  return used > 0 ? ` · ${used} used up` : ""
}

/**
 * The suffix that counts the exits that are failing, or an empty string.
 *
 * An exit the user paused is out of use on purpose, and an exit nobody
 * tested is not known to be bad. An exit that is not answering, is blocked
 * or is failing is a thing to look at: without this the user learns about a
 * dead backup the moment the exit they rely on runs out, which is too late
 * to do anything about it.
 */
function failingNote(status: StatusLike): string {
  const failing = status.exits.filter(
    (exit) =>
      exit.enabled &&
      !isUsableExit(exit, status) &&
      (exit.status === "unreachable" || exit.status === "blocked" || exit.status === "bad"),
  ).length
  return failing > 0 ? ` · ${failing} failing` : ""
}

/** What the menu says about the current selection. */
export function describeSelection(status: StatusLike): string {
  if (status.selection === "free") {
    // Every free model is routed, so the count of models the provider lists
    // in total would read as a half-finished selection.
    return `Every free model · ${status.routedCount} routed`
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
  // The skipped list holds exits the picker will not use, for any reason: it
  // did not answer, or it is cooling down, or it is used up. Saying "not
  // answering" about an exit that says "rate limited" would be a second,
  // wrong reason next to the right one, so the reason is only added when the
  // exit's own word does not already name one.
  const verdictNames = ["not answering", "rate limited", "used up", "failing", "blocked by OpenCode"]
  if (skipped && !verdictNames.some((reason) => word.includes(reason))) {
    facts.push({ text: "not answering", rank: 5 })
  }
  if (status.exhausted.includes(exit.id) && !word.includes("used up")) {
    facts.push({ text: "used up", rank: 5 })
  }
  facts.push({ text: word, rank: 7 })
  if (exit.latencyMs !== undefined) facts.push({ text: `${exit.latencyMs} ms`, rank: 2 })
  // The traffic this exit has carried, which is what the user wants to see
  // next to a name. The count of selected models is not traffic and is never
  // shown here.
  facts.push({ text: `${exit.stats?.requests ?? 0} req`, rank: 3 })
  // The exit the user chose and the exit that will serve the next request are
  // two things: a chosen exit that is cooling leaves the request to a backup.
  // So the chosen one is marked "chosen" and the other "next", and an exit
  // that is both is marked only "chosen".
  const chosen = status.activeExit?.id === exit.id
  if (chosen) facts.push({ text: "chosen", rank: 6 })
  else if (pickerChoice(status) === exit.id) facts.push({ text: "next", rank: 6 })

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
 * Whether this exit was deployed by this plugin and can still be updated.
 *
 * A relay this plugin deployed has a Vercel project, and redeploying it
 * needs the account it was deployed with. A relay whose account was removed
 * can neither be updated nor have its project deleted, so offering those
 * actions would lead the user into a dead end.
 */
export function isDeployedExit(exit: ExitSummaryLike, status: StatusLike): boolean {
  if (exit.kind !== "relay") return false
  if ((exit.project ?? "").length === 0) return false
  const accounts = status.accounts
  if (accounts.length === 0) return false
  // An older server does not say which account is which, so a relay with a
  // project is taken at its word.
  if (!accounts.some((account) => account.id !== undefined)) return true
  return accounts.some((account) => account.id === (exit.accountId ?? ""))
}

/**
 * Apply the answer to one model's mark.
 *
 * The question asks for the opposite of what the model is doing now: a routed
 * model is asked "Stop routing it?", so confirming takes it out, and a model
 * that is not routed is asked "Route it?", so confirming puts it in.
 */
export function toggleModel(
  picked: ReadonlySet<string>,
  id: string,
  routed: boolean,
): string[] {
  const next = new Set(picked)
  if (routed) next.delete(id)
  else next.add(id)
  return [...next]
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
      deployed: isDeployedExit(exit, status),
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
  | { readonly kind: "test-all-deep" }
  | { readonly kind: "update-all" }
  | { readonly kind: "restore" }
  | { readonly kind: "resume-all" }

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
    // The deep test sends the session token to every exit that is not
    // paused, so it is offered only when there is one to send it to: a
    // row that always ends in "nothing to send it through" would spend the
    // user's confirmation on a no-op. It also replays the captured headers,
    // so it needs a recent routed request to replay.
    if (
      status.exits.some((exit) => exit.enabled) &&
      status.hasRequestSample === true
    ) {
      options.push({
        title: "Deep test all exits",
        value: { kind: "test-all-deep" },
        // The scan sends the session token to every exit that is not paused:
        // "in use" would name a narrower set than the one it touches.
        description: "Real request through each unpaused exit",
      })
    }
  }
  // Only relays that can still be redeployed are offered: a relay whose
  // Vercel account is gone cannot be updated, so offering the row would
  // promise something the server cannot do.
  const updatable = status.exits.filter((exit) => isDeployedExit(exit, status))
  if (updatable.length > 0) {
    options.push({
      title: "Update all relays",
      value: { kind: "update-all" },
      description: `Redeploy the current code to ${updatable.length} relay${updatable.length === 1 ? "" : "s"}`,
    })
  }
  if (status.exhausted.length > 0) {
    options.push({
      title: "Bring used-up exits back",
      value: { kind: "restore" },
      description: `${status.exhausted.length} exit${status.exhausted.length === 1 ? " is" : "s are"} out of use`,
    })
  }
  const paused = status.paused ?? []
  if (paused.length > 0) {
    options.push({
      title: "Resume all paused exits",
      value: { kind: "resume-all" },
      description: `${paused.length} exit${paused.length === 1 ? " is" : "s are"} paused`,
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
  // The reason often names the same exit again ("The next request would go
  // through Frankfurt"), so that one sentence is left out when it repeats
  // the line above it. The rest of the reason is kept: it carries the
  // caveat about what else goes direct. The sentence ends after the whole
  // name: an exit named by its address carries dots of its own, and the
  // first one would cut the reason in the middle of it.
  const named = preview.exit?.name
  let rest = preview.reason
  if (named !== undefined) {
    const at = preview.reason.indexOf(`through ${named}`)
    if (at >= 0) {
      const after = at + `through ${named}`.length
      const stop = preview.reason.indexOf(".", after)
      rest = (stop >= 0 ? preview.reason.slice(stop + 1) : "").trim()
    }
  }
  if (rest.length > 0) lines.push(rest)
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
    // Every free model is routed, so there is nothing to compare: the count
    // of models the provider lists in total would read as a half-finished
    // selection.
    lines.push(`Models: every free model - ${status.routedCount} routed`)
  } else if (status.routedCount === 0) {
    // The stored ids survive a chosen model becoming paid, disappearing from
    // the provider's list, or the catalog being unreadable: saying "no model
    // chosen" then would hide the real reason.
    lines.push(
      (status.customModels?.length ?? 0) > 0
        ? "Models: the chosen models are not available right now - nothing is routed"
        : "Models: no model chosen - nothing is routed",
    )
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
      ? "Background checks: on, every 10 minutes while routing is on"
      : "Background checks: off, only when you ask",
  )

  const traffic = trafficCount(status)
  if (traffic === 0) {
    lines.push("No request has gone through an exit since the plugin started.")
  } else {
    const ok = status.exits.reduce((sum, exit) => sum + (exit.stats?.ok ?? 0), 0)
    const rotated = status.exits.reduce((sum, exit) => sum + (exit.stats?.rotated ?? 0), 0)
    const limited = status.exits.reduce((sum, exit) => sum + (exit.stats?.limited ?? 0), 0)
    const failed = status.exits.reduce((sum, exit) => sum + (exit.stats?.failed ?? 0), 0)
    lines.push(
      `${traffic} request${traffic === 1 ? "" : "s"} through exits, of which ${ok} ok, ${rotated} asked for another instance, ${limited} rate-limited, ${failed} failed.`,
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
  // The region a tracked relay runs in: for a relay this plugin deployed the
  // name says it, but a tracked one has no other place to show it.
  if ((exit.regionLabel ?? "").length > 0) lines.push(`Region: ${exit.regionLabel}`)
  // The Vercel project this plugin deployed: removing the exit offers to
  // remove the project with it, and this line is where that name comes from.
  if ((exit.project ?? "").length > 0) lines.push(`Project: ${exit.project}`)
  lines.push(`Status: ${exitStatusWord(exit)}`)
  // The exit the user chose and the exit that will serve the next request are
  // two things: a chosen exit that is cooling leaves the request to a backup,
  // and calling the backup "the chosen exit" would be a lie. With routing
  // off, no exit serves anything, so neither claim is made.
  const chosen = status.activeExit?.id === exit.id
  lines.push(
    !status.enabled
      ? "Routing is off: this exit is not used."
      : chosen
        ? "Chosen exit."
        : pickerChoice(status) === exit.id
          ? "Serves the next request."
          : "Not the chosen exit.",
  )
  // Whether the exit is in use is what the picker says, not what the switch
  // says: an enabled exit whose allowance is gone, or that is cooling, is
  // enabled and not in use. With nothing routed, no exit is in use either,
  // whatever the picker would compute for a request that cannot happen.
  if (!exit.enabled) lines.push("Paused: kept, but not used.")
  else if (status.enabled && status.routedCount > 0 && pickerChoice(status) === exit.id)
    lines.push("In use.")
  else lines.push("Not in use right now.")
  // The countdown is only its own line when the status word does not already
  // carry it: the server derives "used up until <time>" as the label, and
  // saying it twice on one page would be noise.
  if (exit.exhaustedUntil !== undefined && !exitStatusWord(exit).includes("used up until")) {
    lines.push(`Used up until ${resetTime(exit.exhaustedUntil)}.`)
    // The provider's own words, when they were kept: "used up" alone leaves
    // the reader guessing whether it was an allowance, a block, or something
    // else OpenCode answered. The text travelled through the exit, so it is
    // labelled as something the exit reported.
    if (exit.spendReason !== undefined && exit.spendReason.length > 0) {
      lines.push(`OpenCode said, through the exit: ${exit.spendReason}`)
    }
  } else if (exit.spendReason !== undefined && exit.spendReason.length > 0) {
    lines.push(`OpenCode said, through the exit: ${exit.spendReason}`)
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
export function pillTone(status: StatusLike | undefined, reachable = true): PillTone {
  // The server did not answer: nothing routes until it does, so this reads
  // as broken rather than as the quiet it would be if it had answered. This
  // holds even before the first answer, when there is no state to show.
  if (!reachable) return "bad"
  if (!status) return "off"
  // A setup that fails every request is broken, whatever is happening in the
  // background: a test run must not hide a plugin that cannot route. The
  // states that need a look come before the busy one for the same reason.
  const usable = usableExits(status).length
  if (status.enabled && status.routedCount === 0) return "warn"
  if (status.enabled && usable === 0) return status.direct === "never" ? "bad" : "warn"
  // An exit the user paused is out of use on purpose: it is not something to
  // warn about.
  const usedUp = status.exhausted.filter((id) => {
    const exit = status.exits.find((item) => item.id === id)
    return exit === undefined || exit.enabled
  }).length
  // A used-up exit is a thing to look at, so it comes before the busy one
  // too: a scan must not hide it in word or color.
  if (status.enabled && usedUp > 0) return "warn"
  // An exit that is not answering, is blocked or is failing is a thing to
  // look at as well: the user has to know before the exit they rely on runs
  // out, not after.
  if (status.enabled && failingNote(status).length > 0) return "warn"
  // A test run reads as busy even while routing is off: the scan is what is
  // happening right now, whatever the switch says.
  const scanning = status.scanning
  if (scanning !== undefined && scanning.done < scanning.total) return "busy"
  if (!status.enabled) return "off"
  // Routing on, but nothing survives the free-model filter: whatever the
  // exits look like, no request will leave through one. That is a thing to
  // look at, not a healthy state.
  if (status.routedCount === 0) return "warn"
  if (status.exits.length === 0) return "warn"
  if (usable === 0) return status.direct === "never" ? "bad" : "warn"
  return "ok"
}

/**
 * The line the footer shows, or undefined when there is nothing worth saying.
 *
 * `reachable` says whether the server answered the last time it was asked.
 * When it did not, the last snapshot it gave is not the truth any more, and
 * a healthy-looking line would be a lie: the plugin cannot route anything
 * while the server is silent.
 */
export function summarizePill(status: StatusLike | undefined, reachable = true): string | undefined {
  // The server did not answer, and there is no state to show: the plugin
  // cannot route anything, so the pill says so rather than staying silent.
  // The wording says the server, because "not answering" is what an exit
  // that stopped answering is called too. With a snapshot the menu can still
  // open on the last known state, so the suffix carries; without one, it
  // would promise a command that cannot do anything yet.
  if (!reachable) {
    return status !== undefined ? "relay · server not answering · /relay" : "relay · server not answering"
  }
  if (!status) return undefined
  // A background test is the most current fact, so it comes first: it keeps
  // showing while routing is off and before the first exit exists. The
  // routing state is not hidden by it: a test does not make "nothing routed"
  // or "no exit can serve" untrue, and those are the two things the pill has
  // to shout about.
  const scanning = status.scanning
  if (scanning !== undefined && scanning.done < scanning.total) {
    const progress = `testing ${scanning.done}/${scanning.total}`
    // With routing off a used-up exit costs nothing, so the line says what
    // the test run is doing and nothing else.
    if (!status.enabled) return `relay off · ${progress} · /relay`
    // Only the worst thing is named: the line is short, and the states that
    // need the /relay hint are the ones whose tail the footer cuts off.
    const usedUp = status.exhausted.filter((id) => {
      const exit = status.exits.find((item) => item.id === id)
      return exit === undefined || exit.enabled
    }).length
    const failing = failingNote(status)
    const worst =
      usableExits(status).length === 0
        ? "no exit can serve"
        : status.routedCount === 0
          ? "nothing routed"
          : failing.length > 0
            ? failing.slice(3)
            : usedUp > 0
              ? `${usedUp} used up`
              : undefined
    const tail = worst !== undefined ? ` · ${worst} · /relay` : ""
    return `relay on · ${progress}${tail}`
  }
  if (!status.enabled) {
    // The pill is how someone finds the menu again, so it always shows once
    // the plugin exists - even before the first exit.
    return "relay off · /relay"
  }
  if (status.exits.length === 0) return "relay on · no exits · /relay"
  // Routing is on, but nothing is actually routed - a custom selection that
  // lost every entry, a provider that lists no free model, or a model list
  // that could not be read. Naming an exit now would promise routing that
  // cannot happen.
  //
  // Every state that is not healthy carries the /relay suffix: those are the
  // states the user has to open the menu to fix, and the suffix is how they
  // find it.
  if (status.routedCount === 0) return "relay on · nothing routed · /relay"
  const usable = usableExits(status).length
  if (usable === 0) {
    return status.direct === "never"
      ? "relay on · no exit can serve · fail · /relay"
      : "relay on · no exit can serve · direct · /relay"
  }
  // The pill reports traffic: how many requests went through an exit. How
  // many models are selected is not how many requests went anywhere, and
  // showing it here would read as traffic when none has happened.
  //
  // The number belongs to the exit the line names, and only when the line
  // really names it: on an older server that does not say which exit serves,
  // the chosen exit is only named when routing would actually use it, so a
  // used-up chosen exit must not lend its count to the line.
  const named = status.exits.find((exit) => exit.id === pickerChoice(status))
  const traffic =
    named === undefined ||
    status.strategy === "round-robin" ||
    status.strategy === "fastest" ||
    !isUsableExit(named, status)
      ? trafficCount(status)
      : (named.stats?.requests ?? 0)
  // A used-up exit is a state the user has to look at, and so is one that is
  // failing, so the line carries the suffix that leads to the menu even when
  // the traffic looks fine.
  const usedUp = usedUpNote(status)
  const failing = failingNote(status)
  const look = usedUp.length > 0 || failing.length > 0
  return `relay · ${routingName(status)} · ${traffic} req${usedUp}${failing}${look ? " · /relay" : ""}`
}
