/**
 * The footer pill: one line that says what is routed right now.
 *
 * It stays silent for someone who never touched the plugin. An empty footer
 * is better than a placeholder nobody can act on.
 */
import { createMemo, Show } from "solid-js"
import { currentModels, currentStatus, type RelayModel, type RelayStatus } from "./state.ts"

/** How many models the current selection routes. */
function routedCount(status: RelayStatus, models: readonly RelayModel[]): number {
  if (status.selection === "custom") return status.customModels.length
  if (status.selection === "free") return models.filter((model) => model.free).length
  return models.length
}

/** The line the footer shows, or undefined when there is nothing worth saying. */
function summarize(status: RelayStatus | undefined, models: readonly RelayModel[]): string | undefined {
  if (!status) return undefined
  const relay = status.activeRelay
  if (!status.enabled) {
    if (!relay && status.relays.length === 0) return undefined
    return "relay off"
  }
  if (!relay) return "relay on, no relay"
  const count = routedCount(status, models)
  // The command is named, so the footer says how to open the menu.
  return `relay ${relay.name} · ${count} model${count === 1 ? "" : "s"} · /relay`
}

/** The pill itself. */
export function RelayPill() {
  const line = createMemo(() => summarize(currentStatus(), currentModels()))
  return (
    <Show when={line()}>
      {(text) => (
        <box flexDirection="row" flexShrink={1}>
          <text wrapMode="none" truncate>
            {text()}
          </text>
        </box>
      )}
    </Show>
  )
}

/** The pill as the slot renders it; the entry point keeps its own file free of markup. */
export function renderRelayPill() {
  return <RelayPill />
}
