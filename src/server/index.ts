/**
 * The plugin's server half: the hooks that route traffic, the loopback bridge
 * that lets a proxy carry it, and the RPC the terminal part talks to.
 *
 * This file is the glue. The state lives in state.ts, the handlers in
 * handlers.ts, the hooks in hooks.ts, the checks in tester.ts, the models in
 * models.ts, and the contract both halves share is in src/rpc.ts.
 */
import { Plugin } from "@opencode/plugin"
import { Relay } from "../rpc.ts"
import { RelayState } from "./state.ts"
import { ModelCatalog } from "./models.ts"
import { ProxyBridge } from "./bridge.ts"
import { Tester } from "./tester.ts"
import { createHandlers } from "./handlers.ts"
import { registerHooks } from "./hooks.ts"
import { closeSocksBridges } from "./socks-bridge.ts"

export default Plugin.define({
  id: "opencode-relay",
  async setup(context) {
    const state = new RelayState(context.storage)
    // The state is read before anything is registered, so a request that arrives
    // in the first moments is judged by the same rules as every later one.
    await state.load()

    const catalog = new ModelCatalog(context)

    // The bridge only carries requests for proxies that still exist and are
    // enabled. A paused proxy is refused at the bridge too, not only in the
    // routing rules, so a stale request cannot slip through.
    const bridge = new ProxyBridge({
      proxyUrl: (id) => {
        const proxy = state.proxy(id)
        return proxy !== undefined && proxy.enabled ? proxy.url : undefined
      },
    })
    // A bridge that cannot start must not take the plugin with it: the
    // relays still work, and the proxies are simply out of use until it does.
    try {
      bridge.start()
    } catch (error) {
      state.noteFailure(
        `The local proxy bridge could not start, so the proxies are out of use: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    // The handlers and the health checks announce a change through the
    // registration, and the registration is built from the handlers, so the
    // link is made once both exist.
    let announce: (reason: string) => Promise<void> = async () => {}

    const tester = new Tester({
      state,
      announce: (reason) => announce(reason),
    })
    tester.start()

    // The wrapper reads the binding, not the value: the real announce only exists
    // once the registration is built, and the handlers must call that one.
    const handlers = createHandlers({ state, catalog, bridge, tester, announce: (reason) => announce(reason) })
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
        description: "Route OpenCode's free models through relays and proxies of your own",
        execute: async () => {
          await registration.events.emit("menu", {})
        },
      })
    })
    await context.command.reload()

    const hooks = await registerHooks(context, {
      state,
      catalog,
      bridge,
      tester,
      // The traffic counters moved, and the footer shows them. The hooks
      // throttle this, so a busy session does not turn into a storm of
      // status refreshes.
      announceTraffic: () => {
        void announce("traffic moved").catch(() => {})
      },
    })

    // Exits that were added but never checked (an import, a list of proxies)
    // are looked at once the plugin is fully set up, not before. With
    // background checks off this sweep is a check nobody asked for: the exits
    // wait for a test, as the setting promises.
    const startup = state.settings()
    if (
      startup.enabled &&
      startup.healthChecks &&
      state.exits().some((exit) => exit.status === "untested")
    ) {
      void tester.scan("api").catch(() => {})
    }

    return async () => {
      tester.stop()
      bridge.stop()
      closeSocksBridges()
      await Promise.all([hooks.request.dispose(), hooks.response.dispose(), hooks.retry.dispose()])
      await registration.dispose()
    }
  },
})
