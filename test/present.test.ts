import { describe, expect, test } from "bun:test"
import {
  describeExit,
  describeExitDetails,
  describeExits,
  describePreview,
  describeSelection,
  describeSettings,
  describeStatusPage,
  describeStatusSummary,
  exitList,
  exitsMenuOptions,
  menuOptions,
  pillTone,
  statusLabel,
  summarizePill,
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
      "Every free model · 8 routed of 20",
    )
    expect(describeSelection(status({ selection: "custom", customModels: [] }))).toBe(
      "No model chosen · nothing is routed",
    )
    expect(describeSelection(status({ selection: "custom", customModels: ["a"] }))).toBe(
      "1 chosen free model",
    )
    expect(describeSelection(status({ selection: "custom", customModels: ["a", "b"] }))).toBe(
      "2 chosen free models",
    )
  })
})

describe("usableExits", () => {
  test("leaves out paused, used-up, skipped and broken exits", () => {
    const exits = [
      exit({ id: "ok" }),
      exit({ id: "paused", enabled: false }),
      exit({ id: "spent" }),
      exit({ id: "quiet" }),
      exit({ id: "gone", status: "unreachable", statusLabel: "not answering" }),
      exit({ id: "shut", status: "blocked", statusLabel: "blocked by OpenCode" }),
      exit({ id: "worse", status: "bad", statusLabel: "failing" }),
    ]
    const usable = usableExits(
      status({
        exits,
        exhausted: ["spent"],
        skipped: ["quiet"],
      }),
    )

    expect(usable.map((item) => item.id)).toEqual(["ok"])
  })

  test("an exit nobody has tested yet might answer, so it counts", () => {
    const usable = usableExits(status({ exits: [exit({ id: "fresh", status: "untested" })] }))
    expect(usable.map((item) => item.id)).toEqual(["fresh"])
  })
})

describe("describeExits", () => {
  test("counts both kinds and says how many are ready", () => {
    const text = describeExits(
      status({
        exits: [
          exit({ id: "r1" }),
          exit({ id: "r2", status: "unreachable", statusLabel: "not answering" }),
          exit({ id: "p1", kind: "proxy", name: "proxy one" }),
          exit({ id: "p2", kind: "proxy", enabled: false }),
        ],
        paused: ["p2"],
        skipped: ["r2"],
      }),
    )

    expect(text).toBe("4 exits · 2 ready · 1 paused")
  })

  test("counts the used-up ones too", () => {
    const text = describeExits(
      status({
        exits: [exit({ id: "ok" }), exit({ id: "p1", kind: "proxy", enabled: false }), exit({ id: "spent" })],
        paused: ["p1"],
        exhausted: ["spent"],
      }),
    )

    expect(text).toBe("3 exits · 1 ready · 1 paused · 1 used up")
  })

  test("says when there is nothing yet", () => {
    expect(describeExits(status({ exits: [] }))).toBe("No exits yet · add a relay or proxies")
  })
})

describe("describeStatusSummary", () => {
  test("says off, and how many exits are waiting", () => {
    expect(describeStatusSummary(status({ enabled: false, exits: [] }))).toBe("Off · no exits")
    expect(
      describeStatusSummary(status({ enabled: false, exits: [exit({ id: "a" }), exit({ id: "b" })] })),
    ).toBe("Off · 2 exits")
  })

  test("a test run in progress beats everything else", () => {
    expect(
      describeStatusSummary(
        status({
          exits: [exit({ id: "a" }), exit({ id: "b" })],
          scanning: { startedAt: 0, total: 8, done: 3 },
        }),
      ),
    ).toBe("Testing 3/8")
  })

  test("does not pretend an exit can serve when none can", () => {
    const broken = { exits: [exit({ id: "fra", status: "unreachable" })], skipped: ["fra"] }
    expect(describeStatusSummary(status({ ...broken, direct: "allow" }))).toBe(
      "On · no exit can serve · direct",
    )
    expect(describeStatusSummary(status({ ...broken, direct: "never" }))).toBe(
      "On · no exit can serve · fail",
    )
  })

  test("names where routing points and counts the requests that went through", () => {
    expect(
      describeStatusSummary(
        status({ activeExit: { id: "fra", name: "Frankfurt", kind: "relay" } }),
      ),
    ).toBe("On · Frankfurt · 0 req")
    expect(
      describeStatusSummary(
        status({
          activeExit: { id: "fra", name: "Frankfurt", kind: "relay" },
          exits: [exit({ id: "fra", stats: { requests: 3 } })],
        }),
      ),
    ).toBe("On · Frankfurt · 3 req")
  })

  test("names the strategy when no single exit is the answer", () => {
    expect(describeStatusSummary(status({ strategy: "round-robin" }))).toBe(
      "On · round robin · 0 req",
    )
    expect(describeStatusSummary(status({ strategy: "fastest" }))).toBe("On · fastest · 0 req")
    // Fixed, but nothing chosen yet: the next usable one will take it.
    expect(describeStatusSummary(status())).toBe("On · next exit · 0 req")
  })

  test("appends how many exits are used up", () => {
    expect(
      describeStatusSummary(
        status({
          exits: [exit({ id: "fra" }), exit({ id: "p1", kind: "proxy" })],
          activeExit: { id: "fra", name: "Frankfurt", kind: "relay" },
          exhausted: ["p1"],
        }),
      ),
    ).toBe("On · Frankfurt · 0 req · 1 used up")
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
    expect(on?.description).toBe("Requests go straight to OpenCode.")
    expect(off?.title).toBe("Turn routing on")
    expect(off?.description).toBe("Requests use an exit whenever one can serve.")
  })

  test("each hub description is the same line the matching page logic builds", () => {
    const forStatus = status({
      activeExit: { id: "fra", name: "Frankfurt", kind: "relay" },
      selection: "custom",
      customModels: ["a", "b"],
      strategy: "round-robin",
      healthChecks: false,
      exhausted: ["p1"],
      exits: [exit({ id: "fra" }), exit({ id: "p1", kind: "proxy", enabled: false })],
      paused: ["p1"],
    })
    const options = menuOptions(forStatus)

    expect(options.find((option) => option.value === "status")?.description).toBe(
      describeStatusSummary(forStatus),
    )
    expect(options.find((option) => option.value === "models")?.description).toBe(
      describeSelection(forStatus),
    )
    expect(options.find((option) => option.value === "exits")?.description).toBe(
      describeExits(forStatus),
    )
    expect(options.find((option) => option.value === "settings")?.description).toBe(
      describeSettings(forStatus),
    )
    expect(options.find((option) => option.value === "preview")?.description).toBe(
      "See where the next request would go, without sending it",
    )
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
        exits: [exit({ id: "fra", project: "oc-relay-fra" }), exit({ id: "p1", kind: "proxy" })],
        exhausted: ["p1"],
      }),
    )

    expect(options.map((option) => option.title)).toEqual([
      "fra",
      "p1",
      "Test all exits",
      "Update all relays",
      "Bring used-up exits back",
      "Add exits",
      "Back",
    ])
    expect(options.slice(2).map((option) => option.value)).toEqual([
      { kind: "test-all" },
      { kind: "update-all" },
      { kind: "restore" },
      { kind: "add" },
      { kind: "back" },
    ])
  })

  test("test-all needs at least one exit, even proxies only", () => {
    const withProxy = exitsMenuOptions(status({ exits: [exit({ id: "p1", kind: "proxy" })] }))
    expect(withProxy.some((option) => option.value.kind === "test-all")).toBe(true)
    expect(withProxy.find((option) => option.value.kind === "test-all")?.description).toBe(
      "1 exits - checks OpenCode through each",
    )
  })

  test("update-all only for relays this plugin deployed", () => {
    const deployed = exitsMenuOptions(status({ exits: [exit({ id: "r1", project: "oc-relay-r1" })] }))
    const tracked = exitsMenuOptions(status({ exits: [exit({ id: "r1" })] }))
    const proxies = exitsMenuOptions(status({ exits: [exit({ id: "p1", kind: "proxy", project: "x" })] }))

    expect(deployed.some((option) => option.value.kind === "update-all")).toBe(true)
    expect(tracked.some((option) => option.value.kind === "update-all")).toBe(false)
    // A project on a proxy is not something this plugin can redeploy.
    expect(proxies.some((option) => option.value.kind === "update-all")).toBe(false)
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

describe("describeExit", () => {
  test("carries kind, region, state, latency, traffic and the chosen mark", () => {
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

    expect(line).toBe("relay · Frankfurt · ready · 210 ms · 3 req · chosen")
  })

  test("a proxy nobody tested yet says so and counts no traffic", () => {
    const line = describeExit(
      exit({ id: "p1", kind: "proxy", status: "untested", statusLabel: "not tested" }),
      status(),
    )

    expect(line).toBe("proxy · not tested · 0 req")
  })

  test("a paused exit says it is paused", () => {
    const line = describeExit(exit({ id: "p1", kind: "proxy", enabled: false }), status())
    expect(line).toBe("proxy · paused · ready · 0 req")
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
    ).toBe("relay · Frankfurt · ready · 3 req")
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
    expect(list[0]?.description).toBe("relay · Frankfurt · ready · 210 ms · 0 req · chosen")
    expect(list[1]?.value).toEqual({ id: "p1", name: "My proxy", kind: "proxy", deployed: false })
    expect(list[1]?.description).toBe("proxy · used up · ready · 0 req")
  })

  test("a relay this plugin deployed says so, so update can trust the flag", () => {
    const deployed = exitList(status({ exits: [exit({ id: "r1", project: "oc-relay-r1" })] }))
    const tracked = exitList(status({ exits: [exit({ id: "r1" })] }))
    const proxy = exitList(status({ exits: [exit({ id: "p1", kind: "proxy", project: "x" })] }))

    expect(deployed[0]?.value).toEqual({ id: "r1", name: "r1", kind: "relay", deployed: true })
    // A tracked relay has no project to push code to; a project on a proxy is
    // not something this plugin can redeploy either.
    expect(tracked[0]?.value).toEqual({ id: "r1", name: "r1", kind: "relay", deployed: false })
    expect(proxy[0]?.value).toEqual({ id: "p1", name: "p1", kind: "proxy", deployed: false })
  })

  test("carries the exit's last error as a footer", () => {
    const list = exitList(
      status({ exits: [exit({ id: "fra", lastError: "Free allowance gone." })] }),
    )
    expect(list[0]?.footer).toBe("Free allowance gone.")
  })

  test("marks a paused exit and a quiet one", () => {
    const list = exitList(
      status({
        exits: [exit({ id: "p1", kind: "proxy", enabled: false })],
        paused: ["p1"],
        skipped: ["p1"],
      }),
    )

    expect(list[0]?.description).toBe("proxy · paused · not answering · ready · 0 req")
  })
})

describe("summarizePill", () => {
  test("stays silent for someone who never touched the plugin", () => {
    expect(summarizePill(undefined)).toBeUndefined()
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

  test("does not pretend an exit can serve when none can", () => {
    const broken = { exits: [exit({ id: "fra", status: "unreachable" })], skipped: ["fra"] }
    expect(summarizePill(status({ ...broken, direct: "allow" }))).toBe(
      "relay on · no exit can serve · direct",
    )
    expect(summarizePill(status({ ...broken, direct: "never" }))).toBe(
      "relay on · no exit can serve · fail",
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
})

describe("pillTone", () => {
  test("off or missing reads as off", () => {
    expect(pillTone(undefined)).toBe("off")
    expect(pillTone(status({ enabled: false }))).toBe("off")
  })

  test("a test run in progress is busy", () => {
    expect(pillTone(status({ scanning: { startedAt: 0, total: 8, done: 3 } }))).toBe("busy")
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
    expect(on).toContain("Models: every free model - 8 routed of 20")
  })

  test("the model line covers the custom cases too", () => {
    expect(describeStatusPage(status({ selection: "custom", customModels: [] }))).toContain(
      "Models: no model chosen - nothing is routed",
    )
    expect(describeStatusPage(status({ selection: "custom", customModels: ["a", "b"] }))).toContain(
      "Models: 2 chosen free models",
    )
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
      "No request has gone through an exit yet.",
    )

    const busy = describeStatusPage(
      status({
        exits: [
          exit({ id: "fra", stats: { requests: 3, ok: 2, limited: 1, failed: 0 } }),
          exit({ id: "p1", kind: "proxy", stats: { requests: 1, ok: 1, failed: 0 } }),
        ],
      }),
    )
    expect(busy).toContain("4 requests through exits (3 ok, 1 limited, 0 failed).")
  })

  test("lists the exits with their one-line summary and the chosen mark", () => {
    const text = describeStatusPage(
      status({
        exits: [exit({ id: "fra", name: "Frankfurt", regionLabel: "Frankfurt", latencyMs: 210 })],
        activeExit: { id: "fra", name: "Frankfurt", kind: "relay" },
      }),
    )

    expect(text).toContain("Exits: 1")
    expect(text).toContain("  Frankfurt: relay · Frankfurt · ready · 210 ms · 0 req · chosen")
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
