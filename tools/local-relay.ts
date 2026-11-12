/**
 * Runs the relay locally, the way it runs on Vercel.
 *
 * Used to check the plugin end to end without deploying anything: the relay
 * answers on a local port and the plugin talks to it exactly as it would talk
 * to the deployed one.
 *
 *   bun tools/local-relay.ts [port]
 *
 * The access token comes from RELAY_TOKEN. It is never printed: a token in a
 * terminal ends up in a screenshot, a log and a shell history.
 */
import { startRelay } from "./relay-harness.ts"

const port = Number(process.argv[2] ?? 8787)

const relay = await startRelay(port)
console.log(`relay listening on ${relay.url}`)
console.log("set RELAY_TOKEN to the token the relay requires")