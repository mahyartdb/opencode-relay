/**
 * What the terminal UI says, without the terminal.
 *
 * The menu entries and the footer line are pure functions of the status the
 * server reports. Keeping them here means they can be tested without a
 * renderer, and the dialogs only have to run the flows.
 *
 * Relays and proxies are shown as one list of *exits*, because that is how
 * routing treats them: either can carry a request, and the strategy picks
 * among both.
 */
import type { DialogSelectOption } from "@opencode/plugin/tui/context"
import { STRATEGY_LABELS } from "../lib/types.ts"

/** What the main menu can do. */
export type MenuAction =
  | "toggle"
  | "models"
  | "strategy"
  | "direct"
  | "preview"
  | "exits"
  | "deploy"
  | "track-relay"
  | "add-proxies"
  | "test-all"
  | "update-all"
  | "restore"
  | "health"
  | "transfer"
  | "add-account"
  | "remove-account"
  | "close"

/** One exit in a list, with the id the action needs. */
export type ExitChoice = {
  readonly id: string
  readonly name: string
  readonly kind: "relay" | "proxy"
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
  /** How many requests have gone through this exit, when the status carried them. */
  readonly stats?: { readonly requests: number }
}

/** The part of the status the menu and the pill read. */
export interface StatusLike {
  readonly enabled: boolean
  readonly selection: "free" | "custom"
  readonly strategy: "fixed" | "round-robin" | "exhausted" | "fastest"
  readonly direct: "allow" | "never"
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
  }
}

/** The three words a status is shown with. */
const STATUS_LABELS: Record<string, string> = {
  untested: "not checked",
  reachable: "reachable",
  ready: "ready",
  limited: "rate-limited",
  exhausted: "used up",
  blocked: "blocked",
  unreachable: "not answering",
  bad: "answering badly",
  unknown: "not checked",
}

/** The label for a status, whatever spelling the record used. */
export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status
}

/** What the menu says about the current selection. */
export function describeSelection(status: StatusLike): string {
  if (status.selection === "free") return "Now: every free model of the opencode provider"
  if (status.customModels.length === 0) return "Now: nothing is routed"
  const count = status.customModels.length
  return `Now: ${count} chosen free model${count === 1 ? "" : "s"} of the opencode provider`
}

/** The exits that are neither paused nor out of use right now. */
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
      exit.status !== "bad" &&
      exit.status !== "untested",
  )
}

/** What the menu says about the exits. */
export function describeExits(status: StatusLike): string {
  if (status.exits.length === 0) return "No relay or proxy yet"
  const relays = status.exits.filter((exit) => exit.kind === "relay").length
  const proxies = status.exits.length - relays
  const parts: string[] = []
  if (relays > 0) parts.push(`${relays} relay${relays === 1 ? "" : "s"}`)
  if (proxies > 0) parts.push(`${proxies} prox${proxies === 1 ? "y" : "ies"}`)
  const usable = usableExits(status).length
  const paused = status.paused?.length ?? 0
  const quiet = paused > 0 ? `, ${paused} paused` : ""
  return `${parts.join(" + ")} - ${usable} ready${quiet}`
}

/** What the menu says about the strategy. */
export function describeStrategy(status: StatusLike): string {
  return `Now: ${STRATEGY_LABELS[status.strategy].title}`
}

/** The main menu, with the entries that would do nothing left out. */
export function menuOptions(status: StatusLike): DialogSelectOption<MenuAction>[] {
  const options: DialogSelectOption<MenuAction>[] = [
    {
      title: status.enabled ? "Turn routing off" : "Turn routing on",
      value: "toggle",
      category: "Routing",
      description: status.enabled
        ? "Requests go straight to OpenCode again"
        : "Requests go through your relays and proxies",
    },
    {
      title: "Choose models to route",
      value: "models",
      category: "Routing",
      description: describeSelection(status),
    },
    {
      title: "Choose how exits are used",
      value: "strategy",
      category: "Routing",
      description: describeStrategy(status),
    },
    {
      title: "When no exit can serve",
      value: "direct",
      category: "Routing",
      description:
        status.direct === "allow"
          ? "Now: go direct and keep working"
          : "Now: fail instead of going direct",
    },
    {
      title: "Preview the next request",
      value: "preview",
      category: "Routing",
      description: "See which exit it would take, without sending anything",
    },
    {
      title: "Relays and proxies",
      value: "exits",
      category: "Exits",
      description: describeExits(status),
    },
    {
      title: "Deploy a relay",
      value: "deploy",
      category: "Exits",
      description: "Put a relay on your Vercel account",
    },
    {
      title: "Track an existing relay",
      value: "track-relay",
      category: "Exits",
      description: "Use a relay that already runs somewhere",
    },
    {
      title: "Add proxies",
      value: "add-proxies",
      category: "Exits",
      description: "Paste a list of HTTP, HTTPS or SOCKS proxies",
    },
  ]
  if (status.exits.length > 0) {
    options.push({
      title: "Test every exit",
      value: "test-all",
      category: "Checks",
      description: `${status.exits.length} exits - checks OpenCode through each`,
    })
  }
  if (status.exits.some((exit) => exit.kind === "relay" && (exit.project ?? "").length > 0)) {
    options.push({
      title: "Update every relay",
      value: "update-all",
      category: "Checks",
      description: "Redeploy the current code over each relay",
    })
  }
  options.push({
    title: status.exhausted.length > 0 ? "Bring used-up exits back" : "Check used-up exits",
    value: "restore",
    category: "Checks",
    description:
      status.exhausted.length > 0
        ? `${status.exhausted.length} exit${status.exhausted.length === 1 ? " is" : "s are"} out of use`
        : "Nothing is marked used up",
  })
  options.push({
    title: "Background checks",
    value: "health",
    category: "Checks",
    description: "Turn the automatic health checks on or off",
  })
  options.push({
    title: "Export or import",
    value: "transfer",
    category: "Setup",
    description: "Move exits and rules between machines",
  })
  options.push({
    title: "Add a Vercel account",
    value: "add-account",
    category: "Setup",
    description: "Needed only to deploy new relays",
  })
  if (status.accounts.length > 0) {
    options.push({
      title: "Remove a Vercel account",
      value: "remove-account",
      category: "Setup",
      description: `${status.accounts.length} stored`,
    })
  }
  options.push({ title: "Close", value: "close", category: "Setup" })
  return options
}

/** One line that describes an exit, wherever it is shown. */
export function describeExit(exit: ExitSummaryLike, status: StatusLike): string {
  const parts: string[] = [exit.kind === "relay" ? "relay" : "proxy"]
  const where = exit.regionLabel ?? exit.region ?? ""
  if (where.length > 0) parts.push(where)
  if (!exit.enabled) parts.push("paused")
  if (status.exhausted.includes(exit.id)) parts.push("used up")
  if ((status.skipped ?? []).includes(exit.id)) parts.push("not answering")
  parts.push(statusLabel(exit.status))
  if (exit.latencyMs !== undefined) parts.push(`${exit.latencyMs} ms`)
  // The traffic this exit has carried, which is what the user wants to see
  // next to a name. The count of selected models is not traffic and is never
  // shown here.
  const requests = exit.stats?.requests ?? 0
  parts.push(`${requests} request${requests === 1 ? "" : "s"}`)
  if (status.activeExit?.id === exit.id) parts.push("chosen")
  return parts.join(" - ")
}

/**
 * The list of exits, in the shape the menus show them.
 *
 * A relay that is used up, and the one the user chose, are marked here rather
 * than in the dialog, so the marks are testable and the same wherever a list
 * of exits is shown.
 */
export function exitList(status: StatusLike): DialogSelectOption<ExitChoice>[] {
  return status.exits.map((exit) => ({
    title: exit.name,
    value: { id: exit.id, name: exit.name, kind: exit.kind },
    description: describeExit(exit, status),
    ...(exit.lastError !== undefined ? { footer: exit.lastError } : {}),
  }))
}

/** The line the footer shows, or undefined when there is nothing worth saying. */
export function summarizePill(status: StatusLike | undefined): string | undefined {
  if (!status) return undefined
  if (!status.enabled) {
    // Someone who never touched the plugin gets no footer at all.
    if (status.exits.length === 0) return undefined
    return "relay off"
  }
  if (status.exits.length === 0) return "relay on - no exit - /relay"
  const usable = usableExits(status).length
  if (usable === 0) {
    return status.direct === "never"
      ? "relay on - no exit can serve - requests fail - /relay"
      : "relay on - no exit can serve - requests direct - /relay"
  }
  const count = status.exits.reduce((sum, exit) => sum + (exit.stats?.requests ?? 0), 0)
  const used = status.exhausted.length
  const usedNote = used > 0 ? ` - ${used} used up` : ""
  // With round robin or fastest there is no single exit to name, so the
  // strategy is named instead.
  const name =
    status.strategy === "round-robin"
      ? "round robin"
      : status.strategy === "fastest"
        ? "fastest exit"
        : (status.activeExit?.name ?? "next usable exit")
  // The pill reports traffic: how many requests went through an exit. How
  // many models are selected is not how many requests went anywhere, and
  // showing it here would read as traffic when none has happened.
  const traffic = count === 0 ? "no requests yet" : `${count} request${count === 1 ? "" : "s"}`
  return `relay ${name} - ${traffic}${usedNote} - /relay`
}
