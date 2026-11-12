import { defineConfig } from "tsup"
import { solidPlugin } from "esbuild-plugin-solid"

/**
 * The plugin ships compiled JavaScript, not TypeScript source.
 *
 * OpenCode compiles plugin TUI parts with its own Solid transform, but only
 * outside node_modules: a published package is inside node_modules, so its JSX
 * would never be compiled and the plugin would fail to load. Compiling here
 * with the same transform and the same options keeps the published package
 * working and keeps the source readable.
 */
export default defineConfig({
  entry: {
    index: "src/server/index.ts",
    tui: "src/tui/index.ts",
    // The contract on its own, so OpenCode can see that the plugin speaks RPC.
    rpc: "src/rpc.ts",
  },
  format: ["esm"],
  target: "es2022",
  platform: "neutral",
  dts: true,
  clean: true,
  sourcemap: true,
  // The host provides these at runtime; bundling them would give the plugin a
  // second copy of Solid and a second copy of the plugin API.
  external: [
    "@opencode/plugin",
    "@opencode/plugin/*",
    "effect",
    "effect/*",
    "solid-js",
    "solid-js/*",
    "@opentui/core",
    "@opentui/core/*",
    "@opentui/solid",
    "@opentui/solid/*",
  ],
  // The same preset and options OpenTUI itself uses, so the compiled output
  // calls the same runtime helpers the host expects.
  esbuildPlugins: [
    solidPlugin({ solid: { moduleName: "@opentui/solid", generate: "universal" } }),
  ],
})