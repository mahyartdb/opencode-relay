/**
 * The plugin's server half: the hooks that route traffic, and the RPC the
 * terminal part talks to.
 *
 * This file is the glue. The state lives in state.ts, the handlers in
 * handlers.ts, the hooks in hooks.ts, the models in models.ts, and the contract
 * both halves share is in src/rpc.ts.
 */
import { Plugin } from "@opencode/plugin"
import { Relay } from "../rpc.ts"
import { RelayState } from "./state.ts"
import { ModelCatalog } from "./models.ts"
import { createHandlers } from "./handlers.ts"
import { registerHooks } from "./hooks.ts"

export default Plugin.define({
  id: "opencode-relay",
  async setup(context) {
    const state = new RelayState(context.storage)
    // The state is read before anything is registered, so a request that arrives
    // in the first moments is judged by the same rules as every later one.
    await state.load()

    const catalog = new ModelCatalog(context)

    // The handlers announce a change through the registration, and the registration
    // is built from the handlers, so the link is made once both exist.
    let announce: (reason: string) => Promise<void> = async () => {}

    // The wrapper reads the binding, not the value: the real announce only exists once the
    // registration is built, and the handlers must call that one.
    const handlers = createHandlers({ state, catalog, announce: (reason) => announce(reason) })
    const registration = await context.rpc.register(Relay, handlers)
    announce = async (reason: string) => {
      await registration.events.emit("changed", { reason })
    }

    // The command lives on the server, because that is where the list of commands the
    // prompt offers comes from. The menu it opens is a dialog, so the server
    // only asks the terminal part to open it.
    await context.command.transform((editor) => {
      editor.add({
        name: "relay",
        description: "Route OpenCode's free models through a relay of your own",
        execute: async () => {
          await registration.events.emit("menu", {})
        },
      })
    })
    await context.command.reload()

    const hooks = await registerHooks(context, { state, catalog })

    return async () => {
      await Promise.all([hooks.request.dispose(), hooks.response.dispose(), hooks.retry.dispose()])
      await registration.dispose()
    }
  },
})