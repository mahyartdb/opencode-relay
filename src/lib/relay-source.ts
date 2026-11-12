/**
 * The relay source that gets deployed to Vercel, and the project name it lands under.
 *
 * The relay is a single JavaScript file that ships inside this package, so the
 * plugin never inlines a copy of it in code: it reads the shipped file and
 * hands the text to `deployRelay`, which uploads it as `api/relay.js`.
 */

import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** Longest project name Vercel accepts. */
const MAX_NAME_LENGTH = 63

/** Name used when a region and suffix sanitise away to nothing. */
const FALLBACK_NAME = "oc-relay"

/**
 * The directory the relay file lives in, found by walking up from this module.
 *
 * The file sits in the package root, but this module sits in `src/lib` when it
 * runs from source and in `dist` when it runs from the built package, so the
 * depth is not fixed. Walking up until the relay turns up works in both.
 */
function findRelayDirectory(): string {
  let directory = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(directory, "relay", "relay.js"))) return directory
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
}

/** The absolute path of the relay source file shipped with this package. */
export function relayPath(): string {
  return join(findRelayDirectory(), "relay", "relay.js")
}

/** The relay source, as the text deployed to Vercel. */
export function relaySource(): string {
  const path = relayPath()
  try {
    return readFileSync(path, "utf-8")
  } catch {
    // Name the path we looked at: a missing relay is a broken package install, not a bad request.
    throw new Error(`Relay source not found at ${path}. The package seems to be installed without its relay/ folder.`)
  }
}

/** Keeps only what Vercel accepts in a project name: lowercase letters, digits and hyphens. */
function sanitise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/** A Vercel project name for a relay in `region`. */
export function projectName(input: { readonly region: string; readonly suffix?: string }): string {
  // The prefix keeps every relay of this plugin identifiable in the Vercel dashboard; the region keeps
  // relays of different regions apart, since a project can only run in one region.
  const parts = ["oc-relay", sanitise(input.region), sanitise(input.suffix ?? "")].filter((part) => part.length > 0)
  // Truncating can leave a trailing hyphen, which Vercel rejects, so drop it afterwards.
  const name = parts.join("-").slice(0, MAX_NAME_LENGTH).replace(/-+$/, "")
  return name.length > 0 ? name : FALLBACK_NAME
}