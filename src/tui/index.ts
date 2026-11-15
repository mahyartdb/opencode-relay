/**
 * The TUI half of the relay plugin.
 *
 * The server owns the truth; this file turns it into a slash command, a menu
 * and a small pill in the prompt footer. Nothing here decides anything: every
 * change goes through the RPC contract.
 */
import { Plugin } from "@opencode/plugin/tui"
import type { ColorInput } from "@opentui/core"
import {
  openRelayMenu,
  refreshErrorToaster,
  refreshStatus,
  relayClient,
  releaseRelayMenu,
  resetRefresh,
  reportError,
} from "./dialogs.tsx"
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

/**
 * The four colors the pill needs, read from the theme.
 *
 * The theme is read every time the pill draws, not once at activation: a
 * theme switch does not re-run the plugin's setup, so colors read once would
 * leave the pill with the previous theme's palette. Every read is
 * defensive: not every build of the theme carries every key, and a thrown
 * read here would take down the whole plugin at activation.
 */
function pillColors(theme: unknown): {
  muted: ColorInput
  warning: ColorInput
  error: ColorInput
  info: ColorInput
} {
  const resolved = theme as Partial<PillTheme> | undefined
  const feedback = (key: "warning" | "error" | "info", fallback: string): ColorInput =>
    resolved?.text?.feedback?.[key]?.base ?? fallback
  return {
    muted: resolved?.text?.muted ?? "#6c6c6c",
    warning: feedback("warning", "#e5c07b"),
    error: feedback("error", "#e06c75"),
    info: feedback("info", "#61afef"),
  }
}

/**
 * How often the pill asks the server how it is.
 *
 * The answer is local and cheap, and a server that stops answering says
 * nothing, so a timer is the only thing that notices. A quarter of a minute
 * is short enough that a dead server shows up while the user is still looking
 * at the screen, and long enough not to talk to the server for sport.
 */
const HEARTBEAT_MS = 15_000

export default Plugin.define({
  id: "opencode-relay-tui",
  setup(context) {
    const client = relayClient(context)

    const openMenu = () => {
      void openRelayMenu(context, client).catch((error: unknown) => {
        reportError(context, "Relay", error)
      })
    }

    // The pill and the menu share one snapshot, so the footer can never claim
    // something different from the dialog the user just used.
    const releaseSlot = context.ui.slot({
      append: "prompt.footer.status",
      render: () => renderRelayPill(pillColors(context.theme), openMenu),
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

    /**
     * A refresh that failed is a fact the user needs, once.
     *
     * The event path has no dialog to show a toast in, so without this a
     * dead server would leave the pill frozen on a healthy-looking line and
     * the user with no idea why nothing routes. The memory is shared with
     * the menu's own toaster: the same dead server is reported once,
     * whoever saw it first.
     */
    /**
     * Whether this activation is still the one on screen.
     *
     * A refresh that was already in flight when the plugin was deactivated
     * must not toast for a plugin that is gone.
     */
    let alive = true

    const reportRefresh = refreshErrorToaster(context)

    const reportFailure = (error: unknown): void => {
      if (!alive) return
      reportRefresh({ ok: false, error })
    }

    const refresh = (): void => {
      void refreshStatus(context, client).then((result) => {
        if (!alive) return
        if (result.ok) {
          reportRefresh(result)
          return
        }
        reportFailure(result.error)
      })
    }

    // The server says when something changed; the pill follows.
    const unsubscribe = client.events.on("changed", refresh)

    // The prompt runs the command on the server, which cannot open a dialog.
    // It asks the terminal part to, and this is where that happens.
    const unsubscribeMenu = client.events.on("menu", () => {
      openMenu()
    })

    // The provider's model list can change under us, and the routed count with it.
    const stopModels = context.data.on("model.updated", refresh)

    /**
     * The heartbeat: the pill asks the server now and then.
     *
     * A server that stops answering says nothing, so nothing would trigger a
     * refresh and the pill would keep painting a state that stopped being
     * true. Asking on a timer is what lets the pill notice, and recover by
     * itself when the server is back.
     */
    const heartbeat = setInterval(refresh, HEARTBEAT_MS)

    // The first paint: the pill must know the state before anyone asks for
    // it. The two halves of the plugin load independently, so the server may
    // not have registered its RPC yet; the retries turn that race into a
    // short wait instead of a missing pill.
    //
    // The window is wide on purpose: a server that is still starting must
    // not be painted as dead, and the heartbeat owns the dead verdict from
    // then on. Nothing is toasted here: the pill says it, and a toast on a
    // plugin that is merely starting would be a wrong word.
    const firstPaint = async (): Promise<void> => {
      for (const wait of [250, 500, 1000, 2000, 4000]) {
        const result = await refreshStatus(context, client, { quiet: true })
        if (result.ok) return
        await new Promise((resolve) => setTimeout(resolve, wait))
      }
      // The server is still not there: the pill says so, and the heartbeat
      // keeps asking, so the pill recovers by itself.
      await refreshStatus(context, client)
    }
    void firstPaint()

    return () => {
      alive = false
      unsubscribe()
      unsubscribeMenu()
      stopModels()
      releaseSlot()
      clearInterval(heartbeat)
      // The keymap layer belongs to the host, which releases it right after
      // this cleanup runs; there is no handle to call.
      clearState()
      // The menu guard lives in a module that outlives this activation: a
      // plugin that is reloaded with its menu open would otherwise stay
      // locked out of its own menu. The refresh latch lives in the same kind
      // of module, and a new activation must not join the old promise.
      releaseRelayMenu()
      resetRefresh()
    }
  },
})
