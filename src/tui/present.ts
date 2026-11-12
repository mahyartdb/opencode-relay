/**
 * What the terminal UI says, without the terminal.
 *
 * The menu entries and the footer line are pure functions of the status the
 * server reports. Keeping them here means they can be tested without a
 * renderer, and the dialogs only have to run the flows.
 */
import type { DialogSelectOption } from "@opencode/plugin/tui/context"
import { STRATEGY_LABELS } from "../lib/types.ts"

/** What the main menu can do. */
export type MenuAction =
  | "toggle"
  | "models"
  | "strategy"
  | "relay"
  | "deploy"
  | "track-relay"
  | "add-account"
  | "remove-account"
  | "remove-relay"
  | "test"
  | "update"
  | "restore"
  | "close"

/** One relay in a list, with the id the action needs. */
export type RelayChoice = { readonly id: string; readonly name: string }

/** The shape of a relay in a list, without the whole contract. */
export interface RelaySummaryLike {
  readonly id: string
  readonly name: string
  readonly region: string
  readonly regionLabel: string
  readonly status: string
}

/** The part of the status the menu and the pill read. */
export interface StatusLike {
  readonly enabled: boolean
  readonly selection: "all" | "free" | "custom"
  readonly strategy: "fixed" | "round-robin" | "exhausted"
  readonly customModels: readonly string[]
  readonly activeRelay?: { readonly id: string; readonly name: string }
  readonly relays: readonly RelaySummaryLike[]
  readonly accounts: readonly { readonly name: string }[]
  readonly exhausted: readonly string[]
  /** Relays that are skipped because they did not answer. */
  readonly skipped?: readonly string[]
}

/** The part of a model the pill counts. */
export interface ModelLike {
  readonly free: boolean
}

/** What the menu says about the current selection. */
export function describeSelection(status: StatusLike): string {
  if (status.selection === "all") return "Now: every model"
  if (status.selection === "free") return "Now: the free models only"
  if (status.customModels.length === 0) return "Now: nothing is routed"
  const count = status.customModels.length
  return `Now: ${count} chosen model${count === 1 ? "" : "s"}`
}

/** What the menu says about the relays. */
export function describeRelays(status: StatusLike): string {
  if (status.relays.length === 0) return "No relay yet"
  const skipped = new Set(status.skipped ?? [])
  // A relay that is used up or not answering is not ready to use, and saying
  // it is would make the count a lie.
  const usable = status.relays.filter(
    (relay) => !status.exhausted.includes(relay.id) && !skipped.has(relay.id),
  ).length
  const quiet = skipped.size > 0 ? `, ${skipped.size} not answering` : ""
  const count = `${usable} of ${status.relays.length} ready to use${quiet}`
  if (status.strategy === "round-robin") return `${count}, taking turns`
  const active = status.activeRelay ? `, ${status.activeRelay.name} is chosen` : ""
  return `${count}${active}`
}

/** The main menu, with the entries that would do nothing left out. */
export function menuOptions(status: StatusLike): DialogSelectOption<MenuAction>[] {
  const options: DialogSelectOption<MenuAction>[] = [
    {
      title: status.enabled ? "Turn routing off" : "Turn routing on",
      value: "toggle",
      category: "Routing",
      description: status.enabled ? "Requests go direct again" : "Requests go through the relay",
    },
    {
      title: "Choose models to route",
      value: "models",
      category: "Routing",
      description: describeSelection(status),
    },
    {
      title: "Choose how the relays are used",
      value: "strategy",
      category: "Routing",
      description: `Now: ${STRATEGY_LABELS[status.strategy].title}`,
    },
    {
      title: "Choose a relay",
      value: "relay",
      category: "Relays",
      description: describeRelays(status),
    },
    { title: "Deploy a relay", value: "deploy", category: "Relays" },
    { title: "Track an existing relay", value: "track-relay", category: "Relays" },
  ]
  if (status.activeRelay) {
    options.push({
      title: "Test the active relay",
      value: "test",
      category: "Relays",
      description: status.activeRelay.name,
    })
    options.push({
      title: "Update the active relay",
      value: "update",
      category: "Relays",
      description: "Redeploy the current code over the same relay",
    })
  }
  if (status.relays.length > 0)
    options.push({ title: "Remove a relay", value: "remove-relay", category: "Relays" })
  if (status.exhausted.length > 0)
    options.push({
      title: "Bring the used-up relays back",
      value: "restore",
      category: "Relays",
      description: `${status.exhausted.length} relay${status.exhausted.length === 1 ? " is" : "s are"} out of use`,
    })
  options.push({ title: "Add a Vercel account", value: "add-account", category: "Accounts" })
  if (status.accounts.length > 0)
    options.push({ title: "Remove an account", value: "remove-account", category: "Accounts" })
  options.push({ title: "Close", value: "close" })
  return options
}

/**
 * The list of relays, in the shape the menus show them.
 *
 * A relay that is used up, and the one the user chose, are marked here rather
 * than in the dialog, so the marks are testable and the same wherever a list
 * of relays is shown.
 */
export function relayList(status: StatusLike): DialogSelectOption<RelayChoice>[] {
  return status.relays.map((relay) => {
    const region = relay.regionLabel || relay.region || "no region"
    const usedUp = status.exhausted.includes(relay.id)
    const chosen = status.activeRelay?.id === relay.id
    const skipping = (status.skipped ?? []).includes(relay.id)
    return {
      title: relay.name,
      value: { id: relay.id, name: relay.name },
      description: [
        region,
        skipping ? "not answering" : relay.status,
        usedUp ? "used up" : "",
        chosen ? "chosen" : "",
      ]
        .filter((part) => part.length > 0)
        .join(" - "),
    }
  })
}

/** How many models the current selection routes. */
export function routedCount(status: StatusLike, models: readonly ModelLike[]): number {
  if (status.selection === "custom") return status.customModels.length
  if (status.selection === "free") return models.filter((model) => model.free).length
  return models.length
}

/** The line the footer shows, or undefined when there is nothing worth saying. */
export function summarizePill(
  status: StatusLike | undefined,
  models: readonly ModelLike[],
): string | undefined {
  if (!status) return undefined
  if (!status.enabled) {
    // Someone who never touched the plugin gets no footer at all.
    if (status.relays.length === 0) return undefined
    return "relay off"
  }
  if (status.relays.length === 0) return "relay on, no relay"
  const count = routedCount(status, models)
  const used = status.exhausted.length
  const usedNote = used > 0 ? ` · ${used} used up` : ""
  // With round robin there is no single relay to name, so the strategy is named.
  const name =
    status.strategy === "round-robin"
      ? "round robin"
      : (status.activeRelay?.name ?? status.relays[0]?.name ?? "relay")
  // The command is named, so the footer says how to open the menu.
  const skipped = status.skipped?.length ?? 0
  const chosenSkipped =
    status.strategy === "fixed" &&
    status.activeRelay !== undefined &&
    (status.skipped ?? []).includes(status.activeRelay.id)
  // When the relay cannot serve, the line must not pretend that it does.
  if (chosenSkipped) return `relay ${name} not answering · requests direct · /relay`
  if (status.strategy !== "fixed" && skipped >= status.relays.length)
    return `relay on · no relay answering · /relay`
  return `relay ${name} · ${count} model${count === 1 ? "" : "s"}${usedNote} · /relay`
}