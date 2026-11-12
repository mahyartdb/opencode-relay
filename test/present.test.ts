import { describe, expect, test } from "bun:test"
import {
  describeRelays,
  describeSelection,
  menuOptions,
  relayList,
  routedCount,
  summarizePill,
  type RelaySummaryLike,
  type StatusLike,
} from "../src/tui/present.ts"

function relay(overrides: Partial<RelaySummaryLike> = {}): RelaySummaryLike {
  return {
    id: "relay-1",
    name: "Frankfurt",
    region: "fra1",
    regionLabel: "Frankfurt",
    status: "ready",
    ...overrides,
  }
}

function status(overrides: Partial<StatusLike> = {}): StatusLike {
  return {
    enabled: true,
    selection: "free",
    strategy: "fixed",
    customModels: [],
    activeRelay: { id: "relay-1", name: "Frankfurt" },
    relays: [relay()],
    accounts: [{ name: "main" }],
    exhausted: [],
    ...overrides,
  }
}

const values = (state: StatusLike) => menuOptions(state).map((option) => option.value)

describe("describeSelection", () => {
  test("names every mode", () => {
    expect(describeSelection(status({ selection: "all" }))).toBe("Now: every model")
    expect(describeSelection(status({ selection: "free" }))).toBe("Now: the free models only")
  })

  test("counts the hand-picked models and their plural", () => {
    expect(describeSelection(status({ selection: "custom", customModels: [] }))).toBe(
      "Now: nothing is routed",
    )
    expect(describeSelection(status({ selection: "custom", customModels: ["a"] }))).toBe(
      "Now: 1 chosen model",
    )
    expect(describeSelection(status({ selection: "custom", customModels: ["a", "b"] }))).toBe(
      "Now: 2 chosen models",
    )
  })
})

describe("describeRelays", () => {
  test("says when there is no relay", () => {
    expect(describeRelays(status({ relays: [], activeRelay: undefined }))).toBe("No relay yet")
  })

  test("names the chosen relay for a fixed strategy", () => {
    expect(describeRelays(status())).toBe("1 of 1 ready to use, Frankfurt is chosen")
  })

  test("counts the relays that are still usable", () => {
    expect(
      describeRelays(
        status({ relays: [relay(), relay({ id: "relay-2", name: "Virginia" })], exhausted: ["relay-2"] }),
      ),
    ).toBe("1 of 2 ready to use, Frankfurt is chosen")
  })

  test("counts the relays that are not answering", () => {
    const state = status({
      relays: [relay(), relay({ id: "relay-2", name: "Virginia" })],
      skipped: ["relay-2"],
    })
    expect(describeRelays(state)).toBe("1 of 2 ready to use, 1 not answering, Frankfurt is chosen")
  })

  test("does not name a chosen relay for round robin", () => {
    const state = status({
      strategy: "round-robin",
      relays: [relay(), relay({ id: "relay-2", name: "Virginia" })],
    })

    expect(describeRelays(state)).toBe("2 of 2 ready to use, taking turns")
  })
})

describe("relayList", () => {
  test("marks a relay that is not answering", () => {
    const [first] = relayList(status({ skipped: ["relay-1"] }))
    expect(first?.description).toContain("not answering")
  })
})

describe("menuOptions", () => {
  test("a fresh installation offers the ways to begin", () => {
    const options = values(status({ relays: [], accounts: [], activeRelay: undefined }))
    expect(options).toContain("toggle")
    expect(options).toContain("models")
    expect(options).toContain("strategy")
    expect(options).toContain("deploy")
    expect(options).toContain("track-relay")
    expect(options).toContain("add-account")
    expect(options).toContain("close")
  })

  test("entries that would do nothing are left out", () => {
    const options = values(status({ relays: [], accounts: [], activeRelay: undefined }))
    expect(options).not.toContain("test")
    expect(options).not.toContain("update")
    expect(options).not.toContain("remove-relay")
    expect(options).not.toContain("remove-account")
    expect(options).not.toContain("restore")
  })

  test("a relay makes testing, updating and removing possible", () => {
    const options = values(status())
    expect(options).toContain("test")
    expect(options).toContain("update")
    expect(options).toContain("remove-relay")
  })

  test("a used-up relay offers a way back", () => {
    const options = menuOptions(status({ exhausted: ["relay-1"] }))
    const restore = options.find((option) => option.value === "restore")

    expect(restore).toBeDefined()
    expect(restore?.description).toContain("1 relay is out of use")
  })

  test("the toggle says what pressing it does", () => {
    expect(menuOptions(status({ enabled: true }))[0]?.title).toBe("Turn routing off")
    expect(menuOptions(status({ enabled: false }))[0]?.title).toBe("Turn routing on")
  })

  test("the strategy entry says which strategy is in use", () => {
    const option = menuOptions(status({ strategy: "round-robin" })).find(
      (entry) => entry.value === "strategy",
    )

    expect(option?.description).toBe("Now: Round robin")
  })
})

describe("relayList", () => {
  test("names the region and the state", () => {
    expect(relayList(status())[0]).toMatchObject({
      title: "Frankfurt",
      description: "Frankfurt - ready - chosen",
      value: { id: "relay-1", name: "Frankfurt" },
    })
  })

  test("falls back to the region code and then to no region", () => {
    const state = status({ activeRelay: undefined })
    expect(relayList({ ...state, relays: [relay({ regionLabel: "", region: "iad1" })] })[0]?.description).toBe(
      "iad1 - ready",
    )
    expect(relayList({ ...state, relays: [relay({ regionLabel: "", region: "" })] })[0]?.description).toBe(
      "no region - ready",
    )
  })

  test("marks a relay whose allowance is gone", () => {
    const state = status({ exhausted: ["relay-1"] })
    expect(relayList(state)[0]?.description).toBe("Frankfurt - ready - used up - chosen")
  })
})

describe("routedCount", () => {
  const models = [{ free: true }, { free: true }, { free: false }]

  test("counts what the selection means", () => {
    expect(routedCount(status({ selection: "all" }), models)).toBe(3)
    expect(routedCount(status({ selection: "free" }), models)).toBe(2)
    expect(routedCount(status({ selection: "custom", customModels: ["a"] }), models)).toBe(1)
  })
})

describe("summarizePill", () => {
  test("stays silent before the plugin is used", () => {
    expect(summarizePill(undefined, [])).toBeUndefined()
    expect(summarizePill(status({ enabled: false, relays: [] }), [])).toBeUndefined()
  })

  test("says when routing is off but relays are kept", () => {
    expect(summarizePill(status({ enabled: false }), [])).toBe("relay off")
  })

  test("says when routing is on without a relay", () => {
    expect(summarizePill(status({ relays: [], activeRelay: undefined }), [])).toBe(
      "relay on, no relay",
    )
  })

  test("names the relay, the models and the command", () => {
    const models = [{ free: true }, { free: true }]
    expect(summarizePill(status(), models)).toBe("relay Frankfurt · 2 models · /relay")
  })

  test("uses the singular for one model", () => {
    expect(summarizePill(status(), [{ free: true }])).toBe("relay Frankfurt · 1 model · /relay")
  })

  test("names the strategy when the relays take turns", () => {
    const state = status({ strategy: "round-robin", relays: [relay(), relay({ id: "relay-2" })] })
    expect(summarizePill(state, [{ free: true }])).toContain("relay round robin")
  })

  test("counts the relays that are used up", () => {
    expect(summarizePill(status({ exhausted: ["relay-1"] }), [{ free: true }])).toContain(
      "1 used up",
    )
  })

  test("says when the chosen relay is not answering, because requests go direct", () => {
    const state = status({ skipped: ["relay-1"] })
    expect(summarizePill(state, [{ free: true }])).toBe(
      "relay Frankfurt not answering · requests direct · /relay",
    )
  })

  test("says when no relay in a rotation is answering", () => {
    const state = status({
      strategy: "round-robin",
      relays: [relay(), relay({ id: "relay-2" })],
      skipped: ["relay-1", "relay-2"],
    })
    expect(summarizePill(state, [{ free: true }])).toBe("relay on · no relay answering · /relay")
  })

  test("falls back to the first relay when none is chosen", () => {
    const state = status({ activeRelay: undefined })
    expect(summarizePill(state, [{ free: true }])).toContain("relay Frankfurt")
  })
})