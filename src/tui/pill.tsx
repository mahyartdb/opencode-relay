/**
 * The footer pill: one line that says what is routed right now.
 *
 * It stays silent for someone who never touched the plugin. An empty footer
 * is better than a placeholder nobody can act on.
 */
import { createMemo, Show } from "solid-js"
import { summarizePill } from "./present.ts"
import { currentStatus } from "./state.ts"

/** The pill itself. */
export function RelayPill(props: { readonly onOpen: () => void }) {
  const line = createMemo(() => summarizePill(currentStatus()))
  return (
    <Show when={line()}>
      {(text) => (
        <box flexDirection="row" flexShrink={1}>
          <text wrapMode="none" truncate onMouseUp={props.onOpen}>
            {text()}
          </text>
        </box>
      )}
    </Show>
  )
}

/** The pill as the slot renders it; the entry point keeps its own file free of markup. */
export function renderRelayPill(onOpen: () => void) {
  return <RelayPill onOpen={onOpen} />
}
