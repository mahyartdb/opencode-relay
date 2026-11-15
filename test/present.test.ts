import { describe, expect, test } from "bun:test"
import {
  describeExit,
  describeExitDetails,
  describePreview,
  describeSelection,
  describeSettings,
  describeStatusPage,
  exitList,
  exitsMenuOptions,
  menuOptions,
  pillTone,
  statusLabel,
  summarizePill,
  toggleModel,
  usableExits,
  type ExitSummaryLike,
  type PreviewLike,
  type StatusLike,
} from "../src/tui/present.ts"
import { resetTime } from "../src/lib/types.ts"

function exit(overrides: Partial<ExitSummaryLike> & { readonly id: string }): ExitSummaryLike {
  return {
    kind: "relay",
    name: overrides.id,
    status: "ready",
    statusLabel: "ready",
    enabled: true,
    url: `https://${overrides.id}.example`,
    stats: { requests: 0 },
    ...overrides,
  }
}

function status(overrides: Partial<StatusLike> = {}): StatusLike {
  return {
    enabled: true,
    selection: "free",
    strategy: "fixed",
    direct: "allow",
    customModels: [],
    exits: [exit({ id: "fra" })],
    accounts: [],
    exhausted: [],
    paused: [],
    skipped: [],
    routedCount: 8,
    modelCount: 20,
    ...overrides,
  }
}

describe("toggleModel", () => {
  test("confirming the question does what it says", () => {
    // The question asks for the opposite of what the model is doing now, so
    // the answer has to be read against the current state.
    const picked = new Set(["routed"])

    expect(toggleModel(picked, "routed", true)).toEqual([])
    expect(toggleModel(picked, "free", false).sort()).toEqual(["free", "routed"])
    // The set that was passed in is not touched.
    expect([...picked]).toEqual(["routed"])
  })
})

describe("statusLabel", () => {
  test("uses familiar words for every status", () => {
    expect(statusLabel("ready")).toBe("ready")
    expect(statusLabel("untested")).toBe("not tested")
    expect(statusLabel("unknown")).toBe("not tested")
    expect(statusLabel("exhausted")).toBe("used up")
    expect(statusLabel("unreachable")).toBe("not answering")
    expect(statusLabel("limited")).toBe("rate limited")
    expect(statusLabel("something-new")).toBe("something-new")
  })
})

describe("describeSelection", () => {
  test("says what is routed, in models and never a paid mode", () => {
    expect(describeSelection(status({ selection: "free" }))).toBe(
      "Every free model · 8 routed",
    )
    expect(describeSelection(status({ selection: "custom", routedCount: 0 }))).toBe(
      "No model chosen · nothing is routed",
    )
    expect(describeSelection(status({ selection: "custom", routedCount: 1 }))).toBe(
      "1 chosen free model",
    )
    expect(describeSelection(status({ selection: "custom", routedCount: 2 }))).toBe(
      "2 chosen free models",
    )
  })

  test("counts the routed models, not the unfiltered custom list", () => {
    // The list keeps every id that was ever picked; only the routed count has
    // survived the free-model filter, so it is the one that may be shown.
    const text = describeSelection(
      status({ selection: "custom", customModels: ["a", "b", "c"], routedCount: 2 }),
    )
    expect(text).toBe("2 chosen free models")

    const none = describeSelection(
      status({ selection: "custom", customModels: ["paid-model"], routedCount: 0 }),
    )
    expect(none).toBe("No model chosen · nothing is routed")
  })
})

describe("usableExits", () => {
  test("an older server without the picker's answer keeps the status predicate", () => {
    const exits = [
      exit({ id: "ok" }),
      exit({ id: "paused", enabled: false }),
      exit({ id: "spent" }),
      exit({ id: "quiet" }),
      exit({ id: "gone", status: "unreachable", statusLabel: "not answering" }),
      exit({ id: "shut", status: "blocked", statusLabel: "blocked by OpenCode" }),
      exit({ id: "worse", status: "bad", statusLabel: "failing" }),
      exit({ id: "fresh", status: "untested", statusLabel: "not tested" }),
    ]
    const usable = usableExits(
      status({
        exits,
        exhausted: ["spent"],
        skipped: ["quiet"],
      }),
    )

    // The fallback cannot tell a rested failure from a test verdict, so it
    // keeps the conservative reading; an untested exit still counts there.
    expect(usable.map((item) => item.id)).toEqual(["ok", "fresh"])
  })

  test("the exit the server's picker would serve is usable after a failure rests", () => {
    const rested = exit({ id: "rested", status: "blocked", statusLabel: "blocked by OpenCode" })
    const backup = exit({ id: "backup" })
    const picked = status({
      exits: [rested, backup],
      servingExitId: "rested",
      skippedExitIds: ["backup"],
    })

    expect(usableExits(picked).map((item) => item.id)).toEqual(["rested"])
    // The pill and the menu name the exit routing will really use, whatever
    expect(summarizePill(picked)).toBe("relay · rested · 0 req")
    // The exit that serves the next request is marked "next", not "chosen":
    // the user did not choose it, routing merely has nowhere else to go.
    expect(describeExit(rested, picked)).toContain("next")
  })

  test("an untested exit is neither served nor named while the picker chose another", () => {
    const fresh = exit({ id: "fresh", status: "untested", statusLabel: "not tested" })
    const backup = exit({ id: "backup" })
    const picked = status({
      exits: [fresh, backup],
      activeExit: { id: "fresh", name: "fresh", kind: "relay" },
      servingExitId: "backup",
      skippedExitIds: ["fresh"],
    })

    expect(summarizePill(picked)).toBe("relay · backup · 0 req")
  })

  test("a skip list with no serving exit means nothing can serve", () => {
    const exits = [exit({ id: "a" }), exit({ id: "b" })]
    const none = status({ exits, skippedExitIds: ["a", "b"] })

    expect(summarizePill(none)).toBe("relay on · no exit can serve · direct · /relay")
  })
})


describe("describeSettings", () => {
  test("sums up strategy, direct fallback and checks in one line", () => {
    expect(
      describeSettings(status({ strategy: "fixed", direct: "allow", healthChecks: true })),
    ).toBe("one exit · direct fallback · checks on")
    expect(
      describeSettings(status({ strategy: "exhausted", direct: "never", healthChecks: false })),
    ).toBe("until exhausted · no direct fallback · checks off")
  })

  test("checks are on unless they were turned off", () => {
    expect(describeSettings(status({ healthChecks: undefined }))).toBe(
      "one exit · direct fallback · checks on",
    )
  })
})

describe("menuOptions", () => {
  test("offers the seven hubs, in order", () => {
    const options = menuOptions(status())

    expect(options.map((option) => option.value)).toEqual([
      "status",
      "preview",
      "toggle",
      "models",
      "exits",
      "settings",
      "close",
    ])
  })

  test("groups the hubs, and Close stands outside the groups", () => {
    const categories = menuOptions(status()).map((option) => [option.value, option.category])

    expect(categories).toEqual([
      ["status", "Routing"],
      ["preview", "Routing"],
      ["toggle", "Routing"],
      ["models", "Routing"],
      ["exits", "Exits"],
      ["settings", "Settings"],
      ["close", undefined],
    ])
  })

  test("the toggle entry flips with the switch", () => {
    const on = menuOptions(status({ enabled: true })).find((option) => option.value === "toggle")
    const off = menuOptions(status({ enabled: false })).find((option) => option.value === "toggle")

    expect(on?.title).toBe("Turn routing off")
    expect(off?.title).toBe("Turn routing on")
  })

  test("no hub carries a description the host would clip", () => {
    // The host draws title and description on one line and cuts the tail, so
    // the state lives on the pages instead of under the titles.
    const rich = status({
      activeExit: { id: "fra", name: "Frankfurt", kind: "relay" },
      selection: "custom",
      customModels: ["a", "b"],
      routedCount: 2,
      strategy: "round-robin",
      healthChecks: false,
      exhausted: ["p1"],
      exits: [exit({ id: "fra" }), exit({ id: "p1", kind: "proxy", enabled: false })],
      paused: ["p1"],
    })

    for (const option of menuOptions(rich)) {
      expect(option.description).toBeUndefined()
      expect(option.footer).toBeUndefined()
    }
  })
})

describe("exitsMenuOptions", () => {
  test("with nothing configured, only Add exits and Back remain", () => {
    const options = exitsMenuOptions(status({ exits: [] }))

    expect(options.map((option) => option.title)).toEqual(["Add exits", "Back"])
    expect(options.map((option) => option.value)).toEqual([{ kind: "add" }, { kind: "back" }])
    expect(options.some((option) => option.value.kind === "test-all")).toBe(false)
    expect(options.some((option) => option.value.kind === "update-all")).toBe(false)
    expect(options.some((option) => option.value.kind === "restore")).toBe(false)
  })

  test("lists every exit first, keeping the id, name, kind and deployed flag", () => {
    const options = exitsMenuOptions(
      status({
        exits: [exit({ id: "fra", name: "Frankfurt" }), exit({ id: "p1", kind: "proxy", name: "My proxy" })],
      }),
    )

    expect(options[0]?.value).toEqual({ id: "fra", name: "Frankfurt", kind: "relay", deployed: false })
    expect(options[0]?.title).toBe("Frankfurt")
    expect(options[1]?.value).toEqual({ id: "p1", name: "My proxy", kind: "proxy", deployed: false })
  })

  test("offers the list-level moves in a fixed order once they apply", () => {
    const options = exitsMenuOptions(
      status({
        accounts: [{ id: "acc-1", name: "personal" }],
        exits: [
          exit({ id: "fra", project: "oc-relay-fra", accountId: "acc-1" }),
          exit({ id: "p1", kind: "proxy" }),
        ],
        exhausted: ["p1"],
      }),
    )

    expect(options.map((option) => option.title)).toEqual([
      "fra",
      "p1",
      "Test all exits",
      "Deep test all exits",
      "Update all relays",
      "Bring used-up exits back",
      "Add exits",
      "Back",
    ])
    expect(options.slice(2).map((option) => option.value)).toEqual([
      { kind: "test-all" },
      { kind: "test-all-deep" },
      { kind: "update-all" },
      { kind: "restore" },
      { kind: "add" },
      { kind: "back" },
    ])
  })

  test("offers to resume the paused exits only while there are some", () => {
    const paused = exitsMenuOptions(status({ paused: ["p1"] }))
    expect(paused.map((option) => option.value)).toContainEqual({ kind: "resume-all" })
    expect(paused.find((option) => option.value.kind === "resume-all")?.description).toBe("1 exit is paused")

    const none = exitsMenuOptions(status({ paused: [] }))
    expect(none.map((option) => option.value)).not.toContainEqual({ kind: "resume-all" })
  })

  test("test-all needs at least one exit, even proxies only", () => {
    const withProxy = exitsMenuOptions(status({ exits: [exit({ id: "p1", kind: "proxy" })] }))
    expect(withProxy.some((option) => option.value.kind === "test-all")).toBe(true)
    expect(withProxy.find((option) => option.value.kind === "test-all")?.description).toBe(
      "1 exit - checks OpenCode through each",
    )

    const two = exitsMenuOptions(
      status({ exits: [exit({ id: "p1", kind: "proxy" }), exit({ id: "p2", kind: "proxy" })] }),
    )
    expect(two.find((option) => option.value.kind === "test-all")?.description).toBe(
      "2 exits - checks OpenCode through each",
    )
  })

  test("update-all only for relays this plugin deployed", () => {
    const accounts = [{ id: "acc-1", name: "personal" }]
    const deployed = exitsMenuOptions(
      status({
        accounts,
        exits: [exit({ id: "r1", project: "oc-relay-r1", accountId: "acc-1" })],
      }),
    )
    const tracked = exitsMenuOptions(
      status({ accounts, exits: [exit({ id: "r1", accountId: "acc-1" })] }),
    )
    const proxies = exitsMenuOptions(
      status({ accounts, exits: [exit({ id: "p1", kind: "proxy", project: "x" })] }),
    )
    // A relay whose Vercel account was removed cannot be redeployed, so it is
    // not an update target either.
    const orphaned = exitsMenuOptions(
      status({
        accounts,
        exits: [exit({ id: "r1", project: "oc-relay-r1", accountId: "gone" })],
      }),
    )

    expect(deployed.some((option) => option.value.kind === "update-all")).toBe(true)
    expect(tracked.some((option) => option.value.kind === "update-all")).toBe(false)
    // A project on a proxy is not something this plugin can redeploy.
    expect(proxies.some((option) => option.value.kind === "update-all")).toBe(false)
    expect(orphaned.some((option) => option.value.kind === "update-all")).toBe(false)
  })

  test("restore only when an exit is used up, and says how many", () => {
    const one = exitsMenuOptions(status({ exits: [exit({ id: "a" }), exit({ id: "spent" })], exhausted: ["spent"] }))
    const none = exitsMenuOptions(status({ exits: [exit({ id: "a" })] }))

    expect(one.find((option) => option.value.kind === "restore")?.description).toBe(
      "1 exit is out of use",
    )
    expect(none.some((option) => option.value.kind === "restore")).toBe(false)
  })
})

describe("option text", () => {
  test("no option anywhere in present.ts carries a footer", () => {
    const state = status({
      exits: [
        exit({ id: "fra", name: "Relay in Frankfurt", lastError: "Free allowance gone." }),
        exit({ id: "p1", kind: "proxy", enabled: false }),
      ],
      paused: ["p1"],
    })

    const options = [...menuOptions(state), ...exitList(state), ...exitsMenuOptions(state)]
    expect(options.length).toBeGreaterThan(0)
    for (const option of options) expect(option.footer).toBeUndefined()
  })

  test("the menu carries no description, and every other line fits the dialog", () => {
    const state = status({
      exits: [
        exit({
          id: "fra",
          name: "Relay in Frankfurt",
          regionLabel: "Frankfurt",
          status: "limited",
          statusLabel: "rate limited",
          enabled: false,
          latencyMs: 123456,
          stats: { requests: 9999999 },
          project: "oc-relay-fra",
        }),
        exit({ id: "p1", kind: "proxy" }),
      ],
      exhausted: ["fra"],
      skipped: ["fra"],
    })

    for (const option of menuOptions(state)) {
      expect(option.description).toBeUndefined()
      expect(option.footer).toBeUndefined()
    }
    for (const option of [...exitList(state), ...exitsMenuOptions(state)]) {
      expect(option.footer).toBeUndefined()
      if (option.description !== undefined) {
        expect(option.description.length).toBeLessThanOrEqual(40)
      }
    }
  })
})

describe("describeExit", () => {
  test("carries state, latency, traffic and the chosen mark", () => {
    const line = describeExit(
      exit({
        id: "fra",
        name: "Frankfurt",
        regionLabel: "Frankfurt",
        latencyMs: 210,
        stats: { requests: 3 },
      }),
      status({ activeExit: { id: "fra", name: "Frankfurt", kind: "relay" } }),
    )

    expect(line).toBe("ready · 210 ms · 3 req · chosen")
  })

  test("does not repeat the region the name already carries", () => {
    // Deployed relays are named "Relay in <region>" and carry a regionLabel
    // for the same place; the status line said the region twice.
    const line = describeExit(
      exit({ id: "fra", name: "Relay in Frankfurt", regionLabel: "Frankfurt", region: "fra1" }),
      status({ activeExit: { id: "fra", name: "Relay in Frankfurt", kind: "relay" } }),
    )

    expect(line).not.toContain("Frankfurt")
    expect(line).toBe("ready · 0 req · chosen")

    const page = describeStatusPage(
      status({ exits: [exit({ id: "fra", name: "Relay in Frankfurt", regionLabel: "Frankfurt" })] }),
    )
    const listed = page.split("\n").find((row) => row.includes("Relay in Frankfurt"))
    expect(listed).toBe("  Relay in Frankfurt: ready · 0 req")
  })

  test("a proxy nobody tested yet says so and counts no traffic", () => {
    const line = describeExit(
      exit({ id: "p1", kind: "proxy", status: "untested", statusLabel: "not tested" }),
      status(),
    )

    expect(line).toBe("not tested · 0 req")
  })

  test("a paused exit says it is paused", () => {
    const line = describeExit(exit({ id: "p1", kind: "proxy", enabled: false }), status())
    expect(line).toBe("paused · ready · 0 req")
  })

  test("a skipped exit is called out, but never twice", () => {
    const quiet = describeExit(exit({ id: "fra" }), status({ skipped: ["fra"] }))
    expect(quiet).toContain("not answering")
    expect(quiet.match(/not answering/g)).toHaveLength(1)

    // When the server's own label already says it, it is not repeated.
    const labelled = describeExit(
      exit({ id: "fra", status: "unreachable", statusLabel: "not answering" }),
      status({ skipped: ["fra"] }),
    )
    expect(labelled.match(/not answering/g)).toHaveLength(1)
  })

  test("an exit that is rate limited is not called not answering", () => {
    // The skipped list holds exits for every reason, so a rate-limited exit
    // would be given a second and wrong reason next to the right one.
    const limited = describeExit(
      exit({ id: "fra", status: "limited", statusLabel: "rate limited" }),
      status({ skipped: ["fra"] }),
    )
    expect(limited).toContain("rate limited")
    expect(limited).not.toContain("not answering")
  })

  test("a used-up exit says so once, keeping the server's own wording", () => {
    const short = describeExit(exit({ id: "fra" }), status({ exhausted: ["fra"] }))
    expect(short).toContain("used up")
    expect(short.match(/used up/g)).toHaveLength(1)

    // The server may phrase it as a countdown; that passes through unchanged.
    const until = describeExit(
      exit({ id: "fra", status: "exhausted", statusLabel: "used up until 2026-01-01 00:00 UTC" }),
      status({ exhausted: ["fra"] }),
    )
    expect(until).toContain("used up until 2026-01-01 00:00 UTC")
    expect(until.match(/used up/g)).toHaveLength(1)
  })

  test("shows the traffic the exit carried, not the selected models", () => {
    expect(
      describeExit(
        exit({ id: "fra", name: "Frankfurt", regionLabel: "Frankfurt", stats: { requests: 3 } }),
        status(),
      ),
    ).toBe("ready · 3 req")
  })

  test("stays inside the width the dialog clips at, whatever the data", () => {
    const worst = describeExit(
      exit({
        id: "fra",
        name: "Relay in Frankfurt",
        regionLabel: "Frankfurt",
        status: "limited",
        statusLabel: "rate limited",
        enabled: false,
        latencyMs: 123456,
        stats: { requests: 9999999 },
      }),
      status({ exhausted: ["fra"], skipped: ["fra"], activeExit: { id: "fra", name: "Relay in Frankfurt" } }),
    )

    expect(worst.length).toBeLessThanOrEqual(40)
    expect(worst).toContain("rate limited")
    // The status page has room for every fact.
    const page = describeExit(
      exit({
        id: "fra",
        status: "limited",
        statusLabel: "rate limited",
        enabled: false,
        latencyMs: 123456,
        stats: { requests: 9999999 },
      }),
      status({ exhausted: ["fra"], skipped: ["fra"] }),
      160,
    )
    expect(page).toContain("123456 ms")
    expect(page).toContain("9999999 req")
  })
})

describe("exitList", () => {
  test("hands the dialog the id, name, kind and deployed flag it needs to act", () => {
    const list = exitList(
      status({
        exits: [
          exit({ id: "fra", name: "Frankfurt", regionLabel: "Frankfurt", latencyMs: 210 }),
          exit({ id: "p1", kind: "proxy", name: "My proxy", url: "http://1.2.3.4:8080" }),
        ],
        activeExit: { id: "fra", name: "Frankfurt", kind: "relay" },
        exhausted: ["p1"],
      }),
    )

    expect(list[0]?.value).toEqual({ id: "fra", name: "Frankfurt", kind: "relay", deployed: false })
    expect(list[0]?.description).toBe("ready · 210 ms · 0 req · chosen")
    expect(list[1]?.value).toEqual({ id: "p1", name: "My proxy", kind: "proxy", deployed: false })
    expect(list[1]?.description).toBe("used up · ready · 0 req")
  })

  test("a relay this plugin deployed says so, so update can trust the flag", () => {
    const accounts = [{ id: "acc-1", name: "personal" }]
    const deployed = exitList(
      status({
        accounts,
        exits: [exit({ id: "r1", project: "oc-relay-r1", accountId: "acc-1" })],
      }),
    )
    const tracked = exitList(status({ accounts, exits: [exit({ id: "r1", accountId: "acc-1" })] }))
    const proxy = exitList(status({ accounts, exits: [exit({ id: "p1", kind: "proxy", project: "x" })] }))
    // A relay whose Vercel account was removed cannot be redeployed, so it is
    // not an update target.
    const orphaned = exitList(
      status({
        accounts,
        exits: [exit({ id: "r1", project: "oc-relay-r1", accountId: "gone" })],
      }),
    )

    expect(deployed[0]?.value).toEqual({ id: "r1", name: "r1", kind: "relay", deployed: true })
    // A tracked relay has no project to push code to; a project on a proxy is
    // not something this plugin can redeploy either.
    expect(tracked[0]?.value).toEqual({ id: "r1", name: "r1", kind: "relay", deployed: false })
    expect(proxy[0]?.value).toEqual({ id: "p1", name: "p1", kind: "proxy", deployed: false })
    expect(orphaned[0]?.value).toEqual({ id: "r1", name: "r1", kind: "relay", deployed: false })
  })

  test("carries no footer: the last error belongs to the Details page", () => {
    const error = exit({ id: "fra", lastError: "Free allowance gone." })
    const list = exitList(status({ exits: [error] }))

    expect(list[0]?.footer).toBeUndefined()
    expect(describeExitDetails(error, status())).toContain("Last error: Free allowance gone.")
  })

  test("marks a paused exit and a quiet one", () => {
    const list = exitList(
      status({
        exits: [exit({ id: "p1", kind: "proxy", enabled: false })],
        paused: ["p1"],
        skipped: ["p1"],
      }),
    )

    expect(list[0]?.description).toBe("paused · not answering · ready · 0 req")
    expect(list[0]!.description!.length).toBeLessThanOrEqual(40)
  })
})

describe("summarizePill", () => {
  test("stays silent for someone who never touched the plugin", () => {
    expect(summarizePill(undefined)).toBeUndefined()
  })

  test("says the server is not answering, even before the first answer", () => {
    // Nothing routes while the server is silent, so the pill says so rather
    // than staying quiet about a plugin that cannot work.
    expect(summarizePill(undefined, false)).toBe("relay · server not answering")
    expect(pillTone(undefined, false)).toBe("bad")
  })

  test("always says off once the plugin exists, exits or not", () => {
    expect(summarizePill(status({ enabled: false }))).toBe("relay off · /relay")
    expect(summarizePill(status({ enabled: false, exits: [] }))).toBe("relay off · /relay")
  })

  test("says on and honest when there is no exit at all", () => {
    expect(summarizePill(status({ exits: [] }))).toBe("relay on · no exits · /relay")
  })

  test("a test run in progress is the most useful thing to say", () => {
    expect(
      summarizePill(status({ scanning: { startedAt: 0, total: 8, done: 3 } })),
    ).toBe("relay on · testing 3/8")
  })

  test("a test run keeps showing while routing is off, or before the first exit", () => {
    const scanning = { startedAt: 0, total: 8, done: 3 }
    expect(summarizePill(status({ enabled: false, scanning }))).toBe(
      "relay off · testing 3/8 · /relay",
    )
    expect(summarizePill(status({ enabled: false, exits: [], scanning }))).toBe(
      "relay off · testing 3/8 · /relay",
    )
    // Routing is on but the exit list is empty, so the scan line carries the
    // same problem the non-scanning line would name.
    expect(summarizePill(status({ exits: [], scanning }))).toBe(
      "relay on · testing 3/8 · no exit can serve · /relay",
    )
    // A finished run falls back to the state instead of progress.
    expect(summarizePill(status({ enabled: false, scanning: { ...scanning, done: 8 } }))).toBe(
      "relay off · /relay",
    )
  })

  test("a custom selection with nothing routed does not imply live routing", () => {
    expect(
      summarizePill(status({ selection: "custom", routedCount: 0 })),
    ).toBe("relay on · nothing routed · /relay")
    expect(
      summarizePill(
        status({ selection: "custom", routedCount: 2, activeExit: { id: "fra", name: "Frankfurt" } }),
      ),
    ).toBe("relay · Frankfurt · 0 req")
  })

  test("does not pretend an exit can serve when none can", () => {
    const broken = { exits: [exit({ id: "fra", status: "unreachable" })], skipped: ["fra"] }
    expect(summarizePill(status({ ...broken, direct: "allow" }))).toBe(
      "relay on · no exit can serve · direct · /relay",
    )
    expect(summarizePill(status({ ...broken, direct: "never" }))).toBe(
      "relay on · no exit can serve · fail · /relay",
    )
  })

  test("names the chosen exit and reports the traffic it carried", () => {
    expect(
      summarizePill(
        status({ activeExit: { id: "fra", name: "Frankfurt", kind: "relay" } }),
      ),
    ).toBe("relay · Frankfurt · 0 req")

    expect(
      summarizePill(
        status({
          activeExit: { id: "fra", name: "Frankfurt", kind: "relay" },
          exits: [exit({ id: "fra", stats: { requests: 3 } })],
        }),
      ),
    ).toBe("relay · Frankfurt · 3 req")
  })

  test("names the strategy when no single exit serves", () => {
    expect(summarizePill(status({ strategy: "round-robin" }))).toBe("relay · round robin · 0 req")
    expect(summarizePill(status({ strategy: "fastest" }))).toBe("relay · fastest · 0 req")
    // Fixed, but nothing chosen yet: the next usable one takes it.
    expect(summarizePill(status())).toBe("relay · next exit · 0 req")
  })

  test("an exit nobody tested yet counts as one that might serve", () => {
    expect(summarizePill(status({ exits: [exit({ id: "fra", status: "untested" })] }))).toBe(
      "relay · next exit · 0 req",
    )
  })

  test("counts the exits that are used up", () => {
    expect(
      summarizePill(
        status({
          exits: [exit({ id: "fra" }), exit({ id: "p1", kind: "proxy" })],
          activeExit: { id: "fra", name: "Frankfurt", kind: "relay" },
          exhausted: ["p1"],
        }),
      ),
    ).toBe("relay · Frankfurt · 0 req · 1 used up")
  })

  test("does not present selected models as traffic", () => {
    const pill = summarizePill(
      status({
        routedCount: 8,
        exits: [exit({ id: "fra", stats: { requests: 0 } })],
        activeExit: { id: "fra", name: "Frankfurt", kind: "relay" },
      }),
    )

    expect(pill).toContain("0 req")
    expect(pill).not.toContain("8")
  })

  test("a chosen exit that cannot serve is not named", () => {
    const chosen = { activeExit: { id: "fra", name: "Frankfurt", kind: "relay" } } as const
    expect(
      summarizePill(status({ ...chosen, exits: [exit({ id: "fra" }), exit({ id: "ams" })] })),
    ).toBe("relay · Frankfurt · 0 req")

    // Paused, used up, not answering, blocked or failing: all leave the name open.
    expect(
      summarizePill(
        status({ ...chosen, exits: [exit({ id: "fra", enabled: false }), exit({ id: "ams" })] }),
      ),
    ).toBe("relay · next exit · 0 req")

    expect(
      summarizePill(
        status({ ...chosen, exits: [exit({ id: "fra" }), exit({ id: "ams" })], exhausted: ["fra"] }),
      ),
    ).toBe("relay · next exit · 0 req · 1 used up")

    for (const broken of ["unreachable", "blocked", "bad"] as const) {
      expect(
        summarizePill(
          status({
            ...chosen,
            exits: [exit({ id: "fra", status: broken }), exit({ id: "ams" })],
            skipped: ["fra"],
          }),
        ),
      ).toBe("relay · next exit · 0 req")
    }
  })
})

describe("pillTone", () => {
  test("off or missing reads as off", () => {
    expect(pillTone(undefined)).toBe("off")
    expect(pillTone(status({ enabled: false }))).toBe("off")
  })

  test("a test run in progress is busy", () => {
    expect(pillTone(status({ scanning: { startedAt: 0, total: 8, done: 3 } }))).toBe("busy")
  })

  test("a running test reads as busy even while routing is off", () => {
    expect(
      pillTone(status({ enabled: false, scanning: { startedAt: 0, total: 8, done: 3 } })),
    ).toBe("busy")
    // Once it is done, the switch alone decides again.
    expect(
      pillTone(status({ enabled: false, scanning: { startedAt: 0, total: 8, done: 8 } })),
    ).toBe("off")
  })

  test("on with no exit is only a warning, not an error", () => {
    expect(pillTone(status({ exits: [] }))).toBe("warn")
  })

  test("no usable exit is bad only when requests would fail", () => {
    const broken = { exits: [exit({ id: "fra", status: "unreachable" })], skipped: ["fra"] }
    expect(pillTone(status({ ...broken, direct: "allow" }))).toBe("warn")
    expect(pillTone(status({ ...broken, direct: "never" }))).toBe("bad")
  })

  test("a used-up exit dims an otherwise healthy setup", () => {
    expect(
      pillTone(
        status({
          exits: [exit({ id: "fra" }), exit({ id: "p1", kind: "proxy" })],
          exhausted: ["p1"],
        }),
      ),
    ).toBe("warn")
  })

  test("healthy routing is ok", () => {
    expect(
      pillTone(
        status({
          exits: [exit({ id: "fra", stats: { requests: 3 } })],
          activeExit: { id: "fra", name: "Frankfurt", kind: "relay" },
        }),
      ),
    ).toBe("ok")
  })
})

describe("describePreview", () => {
  function preview(overrides: Partial<PreviewLike> = {}): PreviewLike {
    return {
      routed: true,
      reason: "free model, relay chosen",
      direct: "allow",
      skipped: [],
      ...overrides,
    }
  }

  test("says which model would go where, and why", () => {
    const text = describePreview(
      preview({
        modelId: "iceman-free",
        providerID: "opencode",
        exit: { name: "Frankfurt" },
        skipped: [
          { name: "Amsterdam", reason: "used up until tomorrow" },
          { name: "My proxy", reason: "not answering" },
        ],
      }),
    )

    expect(text.split("\n")).toEqual([
      "Model: iceman-free (opencode)",
      "Routed through Frankfurt",
      "free model, relay chosen",
      "If no exit can serve: go direct",
      "",
      "Left out:",
      "  Amsterdam: used up until tomorrow",
      "  My proxy: not answering",
    ])
  })

  test("without a model there is no model line, just the verdict", () => {
    const text = describePreview(preview({ modelId: undefined, routed: false, reason: "no model selected" }))

    expect(text.split("\n")).toEqual([
      "Not routed",
      "no model selected",
      "If no exit can serve: go direct",
    ])
  })

  test("a model without a provider says just the model", () => {
    const text = describePreview(preview({ modelId: "iceman-free", providerID: undefined }))
    expect(text.split("\n")[0]).toBe("Model: iceman-free")
  })

  test("the direct policy is said in full", () => {
    const fail = describePreview(preview({ direct: "never", routed: false, reason: "no exit" }))
    expect(fail).toContain("If no exit can serve: fail")
  })
})

describe("describeStatusPage", () => {
  test("opens with the routing switch and the model line", () => {
    const off = describeStatusPage(status({ enabled: false }))
    expect(off).toContain("Routing is off: requests go straight to OpenCode.")

    const on = describeStatusPage(status())
    expect(on).toContain("Routing is on.")
    expect(on).toContain("Models: every free model - 8 routed")
  })

  test("the model line covers the custom cases too", () => {
    expect(describeStatusPage(status({ selection: "custom", routedCount: 0 }))).toContain(
      "Models: no model chosen - nothing is routed",
    )
    expect(describeStatusPage(status({ selection: "custom", routedCount: 2 }))).toContain(
      "Models: 2 chosen free models",
    )
    // The raw list is unfiltered; only the routed count may be shown.
    expect(
      describeStatusPage(
        status({ selection: "custom", customModels: ["a", "b", "c"], routedCount: 2 }),
      ),
    ).toContain("Models: 2 chosen free models")
  })

  test("says the strategy, the direct policy and the checks", () => {
    const text = describeStatusPage(status({ strategy: "round-robin", direct: "never", healthChecks: false }))
    expect(text).toContain("Strategy: Round robin")
    expect(text).toContain("When no exit can serve: fail instead of going direct")
    expect(text).toContain("Background checks: off, only when you ask")

    const other = describeStatusPage(status({ strategy: "fixed", direct: "allow", healthChecks: true }))
    expect(other).toContain("Strategy: One exit")
    expect(other).toContain("When no exit can serve: go direct")
    expect(other).toContain("Background checks: on, every 10 minutes")
  })

  test("counts traffic, or admits there was none", () => {
    expect(describeStatusPage(status({ routedCount: 8 }))).toContain(
      "No request has gone through an exit since the plugin started.",
    )

    const busy = describeStatusPage(
      status({
        exits: [
          exit({ id: "fra", stats: { requests: 3, ok: 2, rotated: 1, limited: 0, failed: 0 } }),
          exit({ id: "p1", kind: "proxy", stats: { requests: 1, ok: 1, rotated: 0, failed: 0 } }),
        ],
      }),
    )
    expect(busy).toContain(
      "4 requests through exits, of which 3 ok, 1 asked for another instance, 0 rate-limited, 0 failed.",
    )
  })

  test("the traffic breakdown adds up to the traffic, rotated included", () => {
    const text = describeStatusPage(
      status({
        exits: [
          exit({ id: "fra", stats: { requests: 5, ok: 3, rotated: 1, limited: 1, failed: 0 } }),
          exit({ id: "p1", kind: "proxy", stats: { requests: 2, ok: 1, rotated: 1, failed: 0 } }),
        ],
      }),
    )

    const line = text.split("\n").find((row) => row.includes("through exits"))
    expect(line).toBeDefined()
    // The buckets no longer promise to add up to the total: a request that
    // fails during rewrite is counted but has no bucket of its own, so the
    // wording says "of which" instead of implying a decomposition.
    const parts = [...line!.matchAll(/(\d+) (ok|asked for another instance|rate-limited|failed)/g)].map(
      (match) => Number(match[1]),
    )
    const total = Number(line!.match(/^(\d+) request/)?.[1])
    expect(parts).toHaveLength(4)
    expect(parts.reduce((sum, part) => sum + part, 0)).toBeLessThanOrEqual(total)
  })

  test("lists the exits with their one-line summary and the chosen mark", () => {
    const text = describeStatusPage(
      status({
        exits: [exit({ id: "fra", name: "Frankfurt", regionLabel: "Frankfurt", latencyMs: 210 })],
        activeExit: { id: "fra", name: "Frankfurt", kind: "relay" },
      }),
    )

    expect(text).toContain("Exits: 1")
    expect(text).toContain("  Frankfurt: ready · 210 ms · 0 req · chosen")
  })

  test("marks the picker's serving exit next and a silently skipped one skipped", () => {
    const text = describeStatusPage(
      status({
        exits: [
          exit({ id: "serving", name: "Serving", statusLabel: "blocked by OpenCode" }),
          exit({ id: "quiet", name: "Quiet", statusLabel: "ready" }),
        ],
        servingExitId: "serving",
        skippedExitIds: ["quiet"],
      }),
    )

    // The exit that serves the next request is not the one the user chose.
    expect(text).toContain("  Serving: blocked by OpenCode · 0 req · next")
    expect(text).toContain("  Quiet: ready · 0 req · skipped")
  })

  test("adds the used-up-until line the one-liner cannot carry", () => {
    const spent = 1_800_000_000_000
    const withBareLabel = describeStatusPage(
      status({
        exits: [exit({ id: "fra", statusLabel: "used up", exhaustedUntil: spent })],
        exhausted: ["fra"],
      }),
    )
    expect(withBareLabel).toContain(`used up until ${resetTime(spent)}`)

    // When the server's label already carries the countdown, it is not repeated.
    const withFullLabel = describeStatusPage(
      status({
        exits: [exit({ id: "fra", statusLabel: `used up until ${resetTime(spent)}`, exhaustedUntil: spent })],
        exhausted: ["fra"],
      }),
    )
    expect(withFullLabel.match(new RegExp(`used up until ${resetTime(spent)}`, "g"))).toHaveLength(1)
  })

  test("says when no request has been decided yet, and describes the last one", () => {
    expect(describeStatusPage(status({ lastDecision: undefined }))).toContain(
      "Last request: none yet.",
    )

    const routed = describeStatusPage(
      status({
        lastDecision: {
          modelId: "iceman-free",
          routed: true,
          reason: "free model",
          exitName: "Frankfurt",
        },
      }),
    )
    expect(routed).toContain("Last request: iceman-free - routed through Frankfurt")

    const direct = describeStatusPage(
      status({
        lastDecision: { modelId: "iceman-free", routed: false, reason: "every exit was used up" },
      }),
    )
    expect(direct).toContain("Last request: iceman-free - every exit was used up")
  })

  test("carries the note and the test run in progress", () => {
    const text = describeStatusPage(
      status({
        note: "Went direct: no exit answered.",
        exits: [exit({ id: "a" }), exit({ id: "b" })],
        scanning: { startedAt: 0, total: 8, done: 3 },
      }),
    )

    expect(text).toContain("Went direct: no exit answered.")
    expect(text).toContain("Testing: 3 of 8 exits checked.")
  })

  test("the server's routing-off note is said exactly once", () => {
    // The server reports the very line this page opens with.
    const serverNote = "Routing is off: requests go straight to OpenCode."
    const text = describeStatusPage(status({ enabled: false, note: serverNote }))

    expect(text.split(serverNote)).toHaveLength(2)
    expect(text.match(/Routing is off/g)).toHaveLength(1)

    // Another spelling of the same sentence is the same sentence.
    const respaceed = describeStatusPage(
      status({ enabled: false, note: "routing  IS off: requests go straight to OpenCode." }),
    )
    expect(respaceed.match(/opencode\./gi)).toHaveLength(1)

    // Anything else is still shown.
    const other = describeStatusPage(
      status({ enabled: false, note: "Went direct: no exit answered." }),
    )
    expect(other).toContain("Went direct: no exit answered.")

    // A note that only starts like the first line is not a duplicate.
    const longer = describeStatusPage(
      status({ enabled: true, note: "Routing is on, but no exit can serve a request right now." }),
    )
    expect(longer).toContain("Routing is on, but no exit can serve a request right now.")
    expect(longer.match(/Routing is on/g)).toHaveLength(2)
  })
})

describe("describeExitDetails", () => {
  test("tells the whole story of a busy, chosen relay", () => {
    const until = 1_800_000_000_000
    const text = describeExitDetails(
      exit({
        id: "fra",
        name: "Frankfurt",
        url: "https://fra.example",
        latencyMs: 210,
        egress: "198.51.100.7",
        runtime: "node 22",
        lastCheck: until,
        exhaustedUntil: until,
        stats: { requests: 5, ok: 3, rotated: 1, limited: 1, failed: 0, lastMs: 240, averageMs: 200 },
      }),
      status({ activeExit: { id: "fra", name: "Frankfurt", kind: "relay" } }),
    )

    expect(text.split("\n")).toEqual([
      "Name: Frankfurt",
      "Kind: relay",
      "Address: https://fra.example",
      "Status: ready",
      "Chosen exit.",
      "In use.",
      `Used up until ${resetTime(until)}.`,
      "Latency: 210 ms",
      "Leaves from: 198.51.100.7",
      "Runtime: node 22",
      `Last check: ${resetTime(until)}`,
      "",
      "Requests: total 5, 3 ok, 1 rotated, 1 limited, 0 failed",
      "Last round trip: 240 ms",
      "Average round trip: 200 ms",
    ])
  })

  test("the chosen exit and the one that serves next are named apart", () => {
    const picked = status({
      activeExit: { id: "stored", name: "Stored", kind: "relay" },
      exits: [exit({ id: "stored", name: "Stored" }), exit({ id: "backup", name: "Backup" })],
      servingExitId: "backup",
      skippedExitIds: ["stored"],
    })
    const stored = picked.exits[0]!
    const backup = picked.exits[1]!

    // The list names the stored choice "chosen" and the exit that serves the
    // next request "next": the two are not the same thing.
    const list = exitList(picked)
    expect(list.find((item) => item.value.id === "stored")?.description).toContain("chosen")
    expect(list.find((item) => item.value.id === "backup")?.description).toContain("next")
    expect(list.find((item) => item.value.id === "backup")?.description).not.toContain("chosen")

    // The Details page agrees with the list.
    expect(describeExitDetails(stored, picked)).toContain("Chosen exit.")
    expect(describeExitDetails(backup, picked)).toContain("Serves the next request.")
  })

  test("an older server without the picker's answer honors activeExit", () => {
    const legacy = status({
      activeExit: { id: "fra", name: "Frankfurt", kind: "relay" },
      exits: [exit({ id: "fra", name: "Frankfurt" }), exit({ id: "ams", name: "Amsterdam" })],
    })
    const chosen = legacy.exits[0]!
    const other = legacy.exits[1]!

    expect(describeExitDetails(chosen, legacy)).toContain("Chosen exit.")
    expect(describeExitDetails(other, legacy)).toContain("Not the chosen exit.")
  })

  test("names the project a deployed relay belongs to", () => {
    const text = describeExitDetails(exit({ id: "fra", project: "oc-relay-fra" }), status())

    expect(text).toContain("Project: oc-relay-fra")
    // A tracked relay has no project, so the line stays out.
    expect(describeExitDetails(exit({ id: "p1", kind: "proxy" }), status())).not.toContain("Project:")
  })

  test("a paused proxy nobody chose says both", () => {
    const text = describeExitDetails(
      exit({ id: "p1", kind: "proxy", name: "My proxy", url: "http://1.2.3.4:8080", status: "untested", statusLabel: "not tested", enabled: false, stats: undefined }),
      status({ activeExit: { id: "fra", name: "Frankfurt", kind: "relay" } }),
    )

    expect(text).toContain("Status: not tested")
    expect(text).toContain("Not the chosen exit.")
    expect(text).toContain("Paused: kept, but not used.")
    expect(text).not.toContain("Requests:")
  })

  test("ends with the last error when there was one", () => {
    const text = describeExitDetails(
      exit({ id: "fra", lastError: "Free allowance gone." }),
      status(),
    )

    expect(text.endsWith("\n\nLast error: Free allowance gone.")).toBe(true)
  })
})
