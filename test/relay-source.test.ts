import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { isAbsolute, sep } from "node:path"
import { projectName, relayPath, relaySource } from "../src/lib/relay-source.ts"

describe("relayPath", () => {
  test("points at the shipped relay file and is absolute", () => {
    const path = relayPath()
    expect(isAbsolute(path)).toBe(true)
    expect(path.endsWith(`relay${sep}relay.js`)).toBe(true)
  })

  test("does not depend on the working directory", () => {
    const before = relayPath()
    const cwd = process.cwd()
    try {
      process.chdir(sep === "\\" ? "C:\\Windows" : "/")
      expect(relayPath()).toBe(before)
    } finally {
      process.chdir(cwd)
    }
  })
})

describe("relaySource", () => {
  test("returns the real relay file contents", () => {
    const source = relaySource()
    expect(source).toContain("x-relay-target")
    expect(source).toContain("x-relay-key")
    expect(source.length).toBeGreaterThan(1000)
  })

  test("matches the file on disk read directly", () => {
    expect(relaySource()).toBe(readFileSync(relayPath(), "utf-8"))
  })

  test("is stable across calls", () => {
    expect(relaySource()).toBe(relaySource())
  })
})

describe("projectName", () => {
  test("sanitises the region", () => {
    expect(projectName({ region: "FRA1" })).toBe("oc-relay-fra1")
    expect(projectName({ region: "i_a_d1" })).toBe("oc-relay-iad1")
    expect(projectName({ region: "fra 1!" })).toBe("oc-relay-fra1")
  })

  test("appends a sanitised suffix", () => {
    // The sanitiser keeps only [a-z0-9], so a hyphen inside the suffix is dropped too.
    expect(projectName({ region: "fra1", suffix: "team-a" })).toBe("oc-relay-fra1-teama")
    expect(projectName({ region: "fra1", suffix: "Team A!" })).toBe("oc-relay-fra1-teama")
    expect(projectName({ region: "fra1", suffix: "team2" })).toBe("oc-relay-fra1-team2")
  })

  test("ignores a suffix that is empty after sanitising", () => {
    expect(projectName({ region: "fra1", suffix: "" })).toBe("oc-relay-fra1")
    expect(projectName({ region: "fra1", suffix: "!!!" })).toBe("oc-relay-fra1")
  })

  test("falls back to oc-relay for an empty region", () => {
    expect(projectName({ region: "" })).toBe("oc-relay")
    expect(projectName({ region: "---" })).toBe("oc-relay")
    expect(projectName({ region: "", suffix: "!!!" })).toBe("oc-relay")
  })

  test("keeps the name within 63 characters", () => {
    const long = projectName({ region: "a".repeat(200) })
    expect(long.length).toBeLessThanOrEqual(63)
    const longWithSuffix = projectName({ region: "fra1", suffix: "b".repeat(200) })
    expect(longWithSuffix.length).toBeLessThanOrEqual(63)
  })

  test("never ends with a hyphen, even when truncation lands on one", () => {
    // A 53 character region puts the separator before the suffix on the last slot of the 63 character name.
    const name = projectName({ region: "b".repeat(53), suffix: "c" })
    expect(name.length).toBeLessThanOrEqual(63)
    expect(name.endsWith("-")).toBe(false)
    expect(name).toBe(`oc-relay-${"b".repeat(53)}`)
  })

  test("produces names Vercel accepts", () => {
    const inputs = [
      { region: "fra1" },
      { region: "FRA1" },
      { region: "i_a_d1" },
      { region: "" },
      { region: "sfo1", suffix: "My Relay" },
      { region: "sfo1", suffix: "" },
      { region: "x".repeat(100) },
      { region: `${"y".repeat(53)}-z` },
    ]
    for (const input of inputs) {
      const name = projectName(input)
      expect(name).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(name).toMatch(/[a-z0-9]$/)
      expect(name.length).toBeGreaterThanOrEqual(1)
      expect(name.length).toBeLessThanOrEqual(63)
    }
  })

  test("is deterministic", () => {
    expect(projectName({ region: "fra1", suffix: "team" })).toBe(projectName({ region: "fra1", suffix: "team" }))
  })
})
