/**
 * The TUI half of the relay plugin.
 *
 * The server owns the truth; this file turns it into a slash command, a menu
 * and a small pill in the prompt footer. Nothing here decides anything: every
 * change goes through the RPC contract.
 */
import { Plugin } from "@opencode/plugin/tui"
import { openRelayMenu, refreshStatus, relayClient, reportError } from "./dialogs.tsx"
import { renderRelayPill } from "./pill.tsx"
import { clearState } from "./state.ts"

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
      render: () => renderRelayPill(openMenu),
    })

    // The command palette entry opens the menu directly.
    context.keymap.layer(() => ({
      commands: [
        {
          id: "relay",
          title: "Relay",
          description: "Route OpenCode's free models through a relay of your own",
          group: "Relay",
          palette: true,
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
