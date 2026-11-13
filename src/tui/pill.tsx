/**
 * The footer pill: one clickable line that says what is routed right now.
 *
 * The tone carries the health (a problem is visible without reading), the
 * underline appears when the mouse is over it, and a click opens the menu.
 * Healthy states stay quiet: no `/relay` suffix, because someone whose
 * routing works does not need to be told how to find the menu.
 */
import { createMemo, createSignal, Show } from "solid-js"
import { TextAttributes, type ColorInput } from "@opentui/core"
import { pillTone, summarizePill, type PillTone } from "./present.ts"
import { currentStatus } from "./state.ts"

/** The colors the pill needs, resolved from the theme by the entry point. */
export interface PillColors {
  readonly muted: ColorInput
  readonly warning: ColorInput
  readonly error: ColorInput
  readonly info: ColorInput
}

/** The color a tone reads as. */
function toneColor(tone: PillTone, colors: PillColors): ColorInput {
  switch (tone) {
    case "off":
      return colors.muted
    case "warn":
      return colors.warning
    case "bad":
      return colors.error
    case "busy":
      return colors.info
    default:
      return colors.muted
  }
}

/** The pill itself. */
export function RelayPill(props: { readonly colors: PillColors; readonly onOpen: () => void }) {
  const line = createMemo(() => summarizePill(currentStatus()))
  const tone = createMemo(() => pillTone(currentStatus()))
  const [hover, setHover] = createSignal(false)
  return (
    <Show when={line()}>
      {(text) => (
        <box flexDirection="row" flexShrink={1}>
          <text
            wrapMode="none"
            truncate
            fg={toneColor(tone(), props.colors)}
            attributes={hover() ? TextAttributes.UNDERLINE : TextAttributes.NONE}
            onMouseOver={() => setHover(true)}
            onMouseOut={() => setHover(false)}
            onMouseUp={props.onOpen}
          >
            {text()}
          </text>
        </box>
      )}
    </Show>
  )
}

/** The pill as the slot renders it; the entry point keeps its own file free of markup. */
export function renderRelayPill(colors: PillColors, onOpen: () => void) {
  return <RelayPill colors={colors} onOpen={onOpen} />
}
