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

/** The exits that are neither paused nor out of use right now.
 *
 * The filter matches the server's: an exit nobody has tested yet is usable,
 * because it might answer; one that failed to answer, is blocked or is
 * answering badly is not.
 */
export function usableExits(status: StatusLike): readonly ExitSummaryLike[] {
  const exhausted = new Set(status.exhausted)
  const skipped = new Set(status.skipped ?? [])
  return status.exits.filter(
    (exit) =>
      exit.enabled &&
      !exhausted.has(exit.id) &&
      !skipped.has(exit.id) &&
      exit.status !== "unreachable" &&
      exit.status !== "blocked" &&
      exit.status !== "bad",
  )
}

/** The name routing points at, when one exit can be named. */
function routingName(status: StatusLike): string {
  if (status.strategy === "round-robin") return "round robin"
  if (status.strategy === "fastest") return "fastest"
  return status.activeExit?.name ?? "next exit"
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
  if (!status.enabled) {
    return status.exits.length === 0 ? "Off · no exits" : `Off · ${status.exits.length} exits`
  }
  const scanning = status.scanning
  if (scanning && scanning.done < scanning.total) return `Testing ${scanning.done}/${scanning.total}`
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
  if (status.customModels.length === 0) return "No model chosen · nothing is routed"
  const count = status.customModels.length
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

/** What the menu says about the exits. */
export function describeExits(status: StatusLike): string {
  if (status.exits.length === 0) return "No exits yet · add a relay or proxies"
  const parts = [
    `${status.exits.length} exit${status.exits.length === 1 ? "" : "s"}`,
    `${usableExits(status).length} ready`,
  ]
  const paused = status.paused?.length ?? 0
  if (paused > 0) parts.push(`${paused} paused`)
  if (status.exhausted.length > 0) parts.push(`${status.exhausted.length} used up`)
  return parts.join(" · ")
}

/** What the Settings entry about the strategy says. */
export function describeStrategy(status: StatusLike): string {
  return `Now: ${STRATEGY_LABELS[status.strategy].title}`
}

/** The main menu: a few categorized hubs, and nothing that would do nothing. */
export function menuOptions(status: StatusLike): DialogSelectOption<MenuAction>[] {
  return [
    {
      title: "Status",
      value: "status",
      category: "Routing",
      description: describeStatusSummary(status),
    },
    {
      title: "Preview the next request",
      value: "preview",
      category: "Routing",
      description: "See where the next request would go, without sending it",
    },
    {
      title: status.enabled ? "Turn routing off" : "Turn routing on",
      value: "toggle",
      category: "Routing",
      description: status.enabled
        ? "Requests go straight to OpenCode."
        : "Requests use an exit whenever one can serve.",
    },
    {
      title: "Models",
      value: "models",
      category: "Routing",
      description: describeSelection(status),
    },
    {
      title: "Exits",
      value: "exits",
      category: "Exits",
      description: describeExits(status),
    },
    {
      title: "Settings",
      value: "settings",
      category: "Settings",
      description: describeSettings(status),
    },
    { title: "Close", value: "close" },
  ]
}

/** One line that describes an exit, wherever it is shown. */
export function describeExit(exit: ExitSummaryLike, status: StatusLike): string {
  const parts: string[] = [exit.kind === "relay" ? "relay" : "proxy"]
  const where = exit.regionLabel ?? exit.region ?? ""
  if (where.length > 0) parts.push(where)
  if (!exit.enabled) parts.push("paused")
  const word = exitStatusWord(exit)
  const skipped = (status.skipped ?? []).includes(exit.id)
  if (skipped && !word.includes("not answering")) parts.push("not answering")
  if (status.exhausted.includes(exit.id) && !word.includes("used up")) parts.push("used up")
  parts.push(word)
  if (exit.latencyMs !== undefined) parts.push(`${exit.latencyMs} ms`)
  // The traffic this exit has carried, which is what the user wants to see
  // next to a name. The count of selected models is not traffic and is never
  // shown here.
  parts.push(`${exit.stats?.requests ?? 0} req`)
  if (status.activeExit?.id === exit.id) parts.push("chosen")
  return parts.join(" · ")
}

/**
 * The list of exits, in the shape the menus show them.
 *
 * A relay that is used up, and the one the user chose, are marked here rather
 * than in the dialog, so the marks are testable and the same wherever a list
 * of exits is shown. Each value also says whether this plugin deployed the
 * relay, because only such a relay has a project to push code to.
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
    ...(exit.lastError !== undefined ? { footer: exit.lastError } : {}),
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

/** The Exits submenu: every exit, then the list-level moves, then Back. */
export function exitsMenuOptions(status: StatusLike): DialogSelectOption<ExitListAction>[] {
  const options: DialogSelectOption<ExitListAction>[] = [...exitList(status)]
  if (status.exits.length > 0) {
    options.push({
      title: "Test all exits",
      value: { kind: "test-all" },
      description: `${status.exits.length} exits - checks OpenCode through each`,
    })
  }
  if (status.exits.some((exit) => exit.kind === "relay" && (exit.project ?? "").length > 0)) {
    options.push({
      title: "Update all relays",
      value: { kind: "update-all" },
      description: "Redeploy the current code over each relay",
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
    description: "Deploy a relay, track one, or paste proxies",
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
  } else if (status.customModels.length === 0) {
    lines.push("Models: no model chosen - nothing is routed")
  } else {
    const count = status.customModels.length
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
    const limited = status.exits.reduce((sum, exit) => sum + (exit.stats?.limited ?? 0), 0)
    const failed = status.exits.reduce((sum, exit) => sum + (exit.stats?.failed ?? 0), 0)
    lines.push(
      `${traffic} request${traffic === 1 ? "" : "s"} through exits (${ok} ok, ${limited} limited, ${failed} failed).`,
    )
  }

  lines.push("", `Exits: ${status.exits.length}`)
  for (const exit of status.exits) {
    lines.push(`  ${exit.name}: ${describeExit(exit, status)}`)
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

  if (status.note !== undefined && status.note.length > 0) lines.push("", status.note)

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
  lines.push(`Status: ${exitStatusWord(exit)}`)
  lines.push(status.activeExit?.id === exit.id ? "Chosen exit." : "Not the chosen exit.")
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
  if (!status || !status.enabled) return "off"
  const scanning = status.scanning
  if (scanning && scanning.done < scanning.total) return "busy"
  if (status.exits.length === 0) return "warn"
  const usable = usableExits(status).length
  if (usable === 0) return status.direct === "never" ? "bad" : "warn"
  if (status.exhausted.length > 0) return "warn"
  return "ok"
}

/** The line the footer shows, or undefined when there is nothing worth saying. */
export function summarizePill(status: StatusLike | undefined): string | undefined {
  if (!status) return undefined
  if (!status.enabled) {
    // The pill is how someone finds the menu again, so it always shows once
    // the plugin exists - even before the first exit.
    return "relay off · /relay"
  }
  if (status.exits.length === 0) return "relay on · no exits · /relay"
  const scanning = status.scanning
  if (scanning && scanning.done < scanning.total) {
    return `relay on · testing ${scanning.done}/${scanning.total}`
  }
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
