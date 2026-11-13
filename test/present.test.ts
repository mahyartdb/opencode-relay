import { describe, expect, test } from "bun:test"
import {
  describeExit,
  describeExits,
  describeSelection,
  exitList,
  menuOptions,
  statusLabel,
  summarizePill,
  usableExits,
  type ExitSummaryLike,
  type StatusLike,
} from "../src/tui/present.ts"

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
    expect(statusLabel("exhausted")).toBe("used up")
    expect(statusLabel("unreachable")).toBe("not answering")
    expect(statusLabel("unknown")).toBe("not checked")
    expect(statusLabel("something-new")).toBe("something-new")
  })
})

describe("describeSelection", () => {
  test("never mentions a mode that routes paid models", () => {
    expect(describeSelection(status({ selection: "free" }))).toBe(
      "Now: every free model of the opencode provider",
    )
    expect(describeSelection(status({ selection: "custom", customModels: [] }))).toBe(
      "Now: nothing is routed",
    )
    expect(describeSelection(status({ selection: "custom", customModels: ["a"] }))).toBe(
      "Now: 1 chosen free model of the opencode provider",
    )
    expect(describeSelection(status({ selection: "custom", customModels: ["a", "b"] }))).toBe(
      "Now: 2 chosen free models of the opencode provider",
    )
  })

  test("names the provider the free models belong to", () => {
    expect(describeSelection(status({ selection: "free" }))).toContain("opencode provider")
    expect(describeSelection(status({ selection: "custom", customModels: ["a"] }))).toContain(
      "opencode provider",
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
      exit({ id: "blocked", status: "blocked" }),
      exit({ id: "fresh", status: "untested" }),
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
})

describe("describeExits", () => {
  test("counts both kinds and says how many are ready", () => {
    const text = describeExits(
      status({
        exits: [
          exit({ id: "r1" }),
          exit({ id: "r2", status: "unreachable" }),
          exit({ id: "p1", kind: "proxy", name: "proxy one" }),
          exit({ id: "p2", kind: "proxy", enabled: false }),
        ],
        paused: ["p2"],
        skipped: ["r2"],
      }),
    )

    expect(text).toBe("2 relays + 2 proxies - 2 ready, 1 paused")
  })

  test("says when there is nothing yet", () => {
    expect(describeExits(status({ exits: [] }))).toBe("No relay or proxy yet")
  })
})

describe("menuOptions", () => {
  test("offers only free-model routing", () => {
    const options = menuOptions(status())
    const models = options.find((option) => option.value === "models")
    const values = options.map((option) => option.value)

    expect(models?.title).toBe("Choose models to route")
    expect(values).not.toContain("all")
    expect(values).toContain("toggle")
    expect(values).toContain("preview")
    expect(values).toContain("add-proxies")
    expect(values.at(-1)).toBe("close")
  })

  test("offers the relay actions only when a relay exists", () => {
    const withRelay = menuOptions(status()).map((option) => option.value)
    const without = menuOptions(
      status({
        exits: [exit({ id: "p1", kind: "proxy" })],
      }),
    ).map((option) => option.value)

    expect(withRelay).not.toContain("remove-relay")
    expect(withRelay).toContain("exits")
    expect(withRelay).toContain("test-all")
    // A proxy is checked the same way, so test-all does not depend on relays.
    expect(without).toContain("test-all")
  })

  test("offers update-all only for relays this plugin deployed", () => {
    const deployed = menuOptions(
      status({ exits: [exit({ id: "r1", project: "oc-relay-r1" })] }),
    ).map((option) => option.value)
    const tracked = menuOptions(status()).map((option) => option.value)

    expect(deployed).toContain("update-all")
    expect(tracked).not.toContain("update-all")
  })

  test("says how many exits are used up", () => {
    const options = menuOptions(status({ exhausted: ["fra"] }))
    const restore = options.find((option) => option.value === "restore")

    expect(restore?.title).toBe("Bring used-up exits back")
    expect(restore?.description).toContain("1 exit is out of use")
  })

  test("describes direct routing as it is set", () => {
    expect(
      menuOptions(status({ direct: "allow" })).find((option) => option.value === "direct")
        ?.description,
    ).toBe("Now: go direct and keep working")
    expect(
      menuOptions(status({ direct: "never" })).find((option) => option.value === "direct")
        ?.description,
    ).toBe("Now: fail instead of going direct")
  })
})

describe("exitList", () => {
  test("shows the kind, region, state and chosen mark", () => {
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

    expect(list[0]?.description).toBe("relay - Frankfurt - ready - 210 ms - 0 requests - chosen")
    expect(list[1]?.description).toBe("proxy - used up - ready - 0 requests")
    expect(list[0]?.value).toEqual({ id: "fra", name: "Frankfurt", kind: "relay" })
  })

  test("marks a paused exit and a quiet one", () => {
    const list = exitList(
      status({
        exits: [exit({ id: "p1", kind: "proxy", enabled: false })],
        paused: ["p1"],
        skipped: ["p1"],
      }),
    )

    expect(list[0]?.description).toBe("proxy - paused - not answering - ready - 0 requests")
  })
})

describe("describeExit", () => {
  test("carries the error as a note and the status in words", () => {
    const line = describeExit(
      exit({ id: "fra", status: "exhausted", lastError: "Free allowance gone." }),
      status({ exhausted: ["fra"] }),
    )

    expect(line).toContain("used up")
    expect(line).toContain("relay")
  })

  test("shows the traffic the exit carried, not the selected models", () => {
    expect(
      describeExit(
        exit({ id: "fra", name: "Frankfurt", regionLabel: "Frankfurt", stats: { requests: 3 } }),
        status(),
      ),
    ).toBe("relay - Frankfurt - ready - 3 requests")
  })
})

describe("summarizePill", () => {
  test("stays silent for someone who never touched the plugin", () => {
    expect(summarizePill(undefined)).toBeUndefined()
    expect(summarizePill(status({ enabled: false, exits: [] }))).toBeUndefined()
  })

  test("says off or on when there is no exit", () => {
    expect(summarizePill(status({ enabled: false }))).toBe("relay off")
    expect(summarizePill(status({ exits: [] }))).toBe("relay on - no exit - /relay")
  })

  test("names the chosen exit and reports the traffic it carried", () => {
    expect(
      summarizePill(
        status({
          activeExit: { id: "fra", name: "Frankfurt", kind: "relay" },
          routedCount: 1,
        }),
      ),
    ).toBe("relay Frankfurt - no requests yet - /relay")

    expect(
      summarizePill(
        status({
          activeExit: { id: "fra", name: "Frankfurt", kind: "relay" },
          exits: [exit({ id: "fra", stats: { requests: 3 } })],
        }),
      ),
    ).toBe("relay Frankfurt - 3 requests - /relay")
  })

  test("does not present selected models as traffic", () => {
    const pill = summarizePill(
      status({
        routedCount: 8,
        exits: [exit({ id: "fra", stats: { requests: 0 } })],
        activeExit: { id: "fra", name: "Frankfurt", kind: "relay" },
      }),
    )

    expect(pill).toContain("no requests yet")
    expect(pill).not.toContain("8 models")
  })

  test("names the strategy when no single exit serves", () => {
    expect(summarizePill(status({ strategy: "round-robin" }))).toBe(
      "relay round robin - no requests yet - /relay",
    )
    expect(summarizePill(status({ strategy: "fastest" }))).toBe(
      "relay fastest exit - no requests yet - /relay",
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
    ).toBe("relay Frankfurt - no requests yet - 1 used up - /relay")
  })

  test("does not pretend an exit can serve when none can", () => {
    expect(
      summarizePill(
        status({
          exits: [exit({ id: "fra", status: "unreachable" })],
          skipped: ["fra"],
          direct: "allow",
        }),
      ),
    ).toBe("relay on - no exit can serve - requests direct - /relay")
    expect(
      summarizePill(
        status({
          exits: [exit({ id: "fra", status: "unreachable" })],
          skipped: ["fra"],
          direct: "never",
        }),
      ),
    ).toBe("relay on - no exit can serve - requests fail - /relay")
  })

  test("an untested exit is not counted as ready", () => {
    expect(
      summarizePill(status({ exits: [exit({ id: "fra", status: "untested" })] })),
    ).toBe("relay on - no exit can serve - requests direct - /relay")
  })
})
