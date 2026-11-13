/**
 * The TUI half of the relay plugin.
 *
 * The server owns the truth; this file turns it into a slash command, a menu
 * and a small pill in the prompt footer. Nothing here decides anything: every
 * change goes through the RPC contract.
 */
import { Plugin } from "@opencode/plugin/tui"
import type { ColorInput } from "@opentui/core"
import { openRelayMenu, refreshStatus, relayClient, reportError } from "./dialogs.tsx"
import { renderRelayPill } from "./pill.tsx"
import { clearState } from "./state.ts"

/**
 * The part of the host's resolved theme the pill reads. The host's
 * `ResolvedTheme` comes from `@opencode/theme`, a peer dependency of
 * `@opencode/plugin` that this package does not install, so naming the slice
 * keeps these reads checked instead of treating the theme as untyped.
 */
type PillTheme = {
  readonly text: {
    readonly muted: ColorInput
    readonly feedback: Readonly<
      Record<"warning" | "error" | "info", { readonly base: ColorInput }>
    >
  }
}

export default Plugin.define({
  id: "opencode-relay-tui",
  setup(context) {
    const client = relayClient(context)

    const openMenu = () => {
      void openRelayMenu(context, client).catch((error: unknown) => {
        reportError(context, "Relay", error)
      })
    }

    // The theme speaks in nested color tokens, not flat roles; the pill needs
    // four of them. `theme` is a stable host object whose getters resolve the
    // tokens for the active theme, so this keeps the pill legible on light and
    // dark themes alike. The colors are read once, at activation. Every read
    // is defensive: not every build of the theme carries every key, and a
    // thrown read here would take down the whole plugin at activation.
    const theme = context.theme as Partial<PillTheme> | undefined
    const muted = theme?.text?.muted ?? "#6c6c6c"
    const feedback = (key: "warning" | "error" | "info", fallback: string): ColorInput =>
      theme?.text?.feedback?.[key]?.base ?? fallback
    const colors = {
      textMuted: muted,
      warning: feedback("warning", "#e5c07b"),
      error: feedback("error", "#e06c75"),
      info: feedback("info", "#61afef"),
    }

    // The pill and the menu share one snapshot, so the footer can never claim
    // something different from the dialog the user just used.
    const releaseSlot = context.ui.slot({
      append: "prompt.footer.status",
      render: () =>
        renderRelayPill(
          {
            muted: colors.textMuted,
            warning: colors.warning,
            error: colors.error,
            info: colors.info,
          },
          openMenu,
        ),
    })

    // The command palette entry opens the menu directly. alt+r is the global
    // shortcut: ctrl+r is the host's session rename and cannot be taken. A
    // layer defaults to the base input mode, so opt out to keep it global.
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "relay",
          title: "Relay",
          description: "Route OpenCode's free models through relays and proxies you control.",
          group: "Relay",
          palette: true,
          bind: "alt+r",
          run: openMenu,
        },
      ],
    }))

    // The server says when something changed; the pill follows.
    const unsubscribe = client.events.on("changed", () => {
      void refreshStatus(context, client)
    })

    // The prompt runs the command on the server, which cannot open a dialog.
    // It asks the terminal part to, and this is where that happens.
    const unsubscribeMenu = client.events.on("menu", () => {
      openMenu()
    })

    // The provider's model list can change under us, and the routed count with it.
    const stopModels = context.data.on("model.updated", () => {
      void refreshStatus(context, client)
    })

    // The first paint: the pill must know the state before anyone asks for it.
    void refreshStatus(context, client)

    return () => {
      unsubscribe()
      unsubscribeMenu()
      stopModels()
      releaseSlot()
      // The keymap layer belongs to the host, which releases it right after
      // this cleanup runs; there is no handle to call.
      clearState()
    }
  },
})
