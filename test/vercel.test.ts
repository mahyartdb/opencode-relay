import { afterEach, describe, expect, test } from "bun:test"
import { PLAN_LIMITS } from "../src/lib/types.ts"
import {
  deleteVercelProject,
  deployRelay,
  inspectVercel,
  probeRelay,
  type VercelAccount,
} from "../src/lib/vercel.ts"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

describe("inspectVercel", () => {
  test("picks requested team, counts projects, reports projectsMore, and maps plan to limits", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url === "https://api.vercel.com/v2/teams") {
        return jsonResponse({
          teams: [
            { id: "team_other", slug: "other", billing: { plan: "pro" } },
            { id: "team_a", slug: "acme", billing: { plan: "pro" } },
          ],
        })
      }
      if (url === "https://api.vercel.com/v9/projects?limit=100&teamId=team_a") {
        return jsonResponse({
          projects: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
          pagination: { next: "cursor123" },
        })
      }
      throw new Error(`unexpected url: ${url}`)
    }) as unknown as typeof fetch

    const account: VercelAccount = { token: "tok-secret", teamId: "team_a" }
    const plan = await inspectVercel(account)

    expect(plan.plan).toBe("pro")
    expect(plan.team).toBe("acme")
    expect(plan.teams).toBe(2)
    expect(plan.projectsSampled).toBe(3)
    expect(plan.projectsMore).toBe(true)
    expect(plan.limits).toEqual(PLAN_LIMITS["pro"])
    expect(calls.length).toBe(2)
  })

  test("throws on 401", async () => {
    globalThis.fetch = (async () => {
      return jsonResponse({ error: { code: "forbidden", message: "bad token" } }, 401)
    }) as unknown as typeof fetch

    await expect(inspectVercel({ token: "tok-secret" })).rejects.toThrow(
      "Vercel refused the request (HTTP 401/403). Check the token and its permissions.",
    )
  })
})

describe("deployRelay", () => {
  test("posts correct request and returns stable .vercel.app alias (not hashed)", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.startsWith("https://api.vercel.com/v13/deployments?skipAutoDetectionConfirmation=1&teamId=team_a")) {
        return jsonResponse({
          id: "dep_1",
          readyState: "READY",
          alias: ["my-relay-abc123xyz-team.vercel.app", "my-relay.vercel.app"],
          url: "my-relay-hash.vercel.app",
        })
      }
      throw new Error(`unexpected url: ${url}`)
    }) as unknown as typeof fetch

    const result = await deployRelay({
      account: { token: "tok-secret", teamId: "team_a" },
      project: "my-relay",
      region: "fra1",
      runtime: "bun",
      access: "access-secret",
      relaySource: "export default {}",
    })

    expect(result).toEqual({
      id: "dep_1",
      project: "my-relay",
      url: "https://my-relay.vercel.app",
      region: "fra1",
    })

    const post = calls[0]
    expect(post?.url).toBe(
      "https://api.vercel.com/v13/deployments?skipAutoDetectionConfirmation=1&teamId=team_a",
    )
    expect(post?.init?.method).toBe("POST")
    const body = JSON.parse(String(post?.init?.body)) as {
      regions: string[]
      env: { RELAY_TOKEN: string }
      files: Array<{ file: string; data: string }>
      projectSettings: { serverlessFunctionRegion: string }
    }
    expect(body.regions).toEqual(["fra1"])
    expect(body.env.RELAY_TOKEN).toBe("access-secret")
    expect(body.projectSettings.serverlessFunctionRegion).toBe("fra1")
    expect(body.files.map((f) => f.file).sort()).toEqual(["api/relay.js", "package.json", "vercel.json"].sort())
    const vercelJson = body.files.find((f) => f.file === "vercel.json")
    expect(vercelJson?.data).toContain('"bunVersion":"1.x"')
  })

  test("prefers the stable alias over a bare deployment URL, whatever its shape", async () => {
    globalThis.fetch = (async () => {
      // The hashed alias here has no team suffix: `project-9chars.vercel.app`
      // is a deployment URL exactly like `project-hash-team.vercel.app`, and
      // the old dash-only check took it for the stable one.
      return jsonResponse({
        id: "dep_2",
        readyState: "READY",
        alias: ["my-relay-a1b2c3d4e.vercel.app", "my-relay.vercel.app"],
        url: "my-relay-a1b2c3d4e.vercel.app",
      })
    }) as unknown as typeof fetch

    const result = await deployRelay({
      account: { token: "tok-secret" },
      project: "my-relay",
      region: "fra1",
      access: "access-secret",
      relaySource: "export default {}",
    })

    expect(result.url).toBe("https://my-relay.vercel.app")
  })

  test("throws when deployment ends in ERROR", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/v13/deployments?skipAutoDetectionConfirmation=1")) {
        return jsonResponse({
          id: "dep_err",
          readyState: "ERROR",
          errorMessage: "build failed",
        })
      }
      throw new Error(`unexpected url: ${url}`)
    }) as unknown as typeof fetch

    await expect(
      deployRelay({
        account: { token: "tok-secret" },
        project: "my-relay",
        region: "fra1",
        access: "access-secret",
        relaySource: "export default {}",
      }),
    ).rejects.toThrow(/deployment error/i)
  })

  test("a deploy that is not ready at creation is polled to READY", async () => {
    const urls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/v13/deployments?skipAutoDetectionConfirmation=1")) {
        return jsonResponse({ id: "dep_slow", readyState: "BUILDING" })
      }
      if (url.includes("/v13/deployments/dep_slow")) {
        urls.push(url)
        return jsonResponse({
          id: "dep_slow",
          readyState: "READY",
          alias: ["my-relay.vercel.app"],
          url: "my-relay-hash.vercel.app",
        })
      }
      throw new Error(`unexpected url: ${url}`)
    }) as unknown as typeof fetch

    const result = await deployRelay({
      account: { token: "tok-secret" },
      project: "my-relay",
      region: "fra1",
      access: "access-secret",
      relaySource: "export default {}",
    })
    expect(result.url).toBe("https://my-relay.vercel.app")
    expect(urls.length).toBe(1)
  })
})

describe("deleteVercelProject", () => {
  test("treats 404 as success", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      expect(url).toBe("https://api.vercel.com/v9/projects/my-proj?teamId=team_a")
      expect(init?.method).toBe("DELETE")
      return jsonResponse({ error: { message: "not found" } }, 404)
    }) as unknown as typeof fetch

    await expect(deleteVercelProject({ token: "tok-secret", teamId: "team_a" }, "my-proj")).resolves.toBeUndefined()
  })
})

describe("probeRelay", () => {
  test("returns egress/runtime on 200", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://relay.example.com")
      const headers = new Headers(init?.headers)
      expect(headers.get("x-relay-key")).toBe("access-secret")
      expect(headers.get("x-relay-control")).toBe("ping")
      return jsonResponse({ instance: "i1", egress: "1.2.3.4", runtime: "bun", control: "ping" }, 200)
    }) as unknown as typeof fetch

    const probe = await probeRelay("https://relay.example.com", "access-secret")
    expect(probe).toMatchObject({ reachable: true, status: 200, egress: "1.2.3.4", runtime: "bun" })
    expect(probe.ms).toBeGreaterThanOrEqual(0)
  })

  test("returns {reachable:false,status:0} on network error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down")
    }) as unknown as typeof fetch

    const probe = await probeRelay("https://relay.example.com", "access-secret")
    expect(probe).toMatchObject({ reachable: false, status: 0 })
    expect(probe.ms).toBeGreaterThanOrEqual(0)
  })

  test("a 200 that is not JSON is not a reachable relay", async () => {    globalThis.fetch = (async () => {
      return new Response("<html><body>Sign in</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    }) as unknown as typeof fetch

    const probe = await probeRelay("https://relay.example.com", "access-secret")
    expect(probe).toMatchObject({ reachable: false, status: 200 })
    expect(probe.ms).toBeGreaterThanOrEqual(0)
  })

  test("a 200 with a JSON array body is not a reachable relay", async () => {
    globalThis.fetch = (async () => {
      return jsonResponse([1, 2, 3], 200)
    }) as unknown as typeof fetch

    const probe = await probeRelay("https://relay.example.com", "access-secret")
    expect(probe).toMatchObject({ reachable: false, status: 200 })
    expect(probe.ms).toBeGreaterThanOrEqual(0)
  })

  test("a redirect is not followed, so the access key stays put", async () => {
    let seen: { readonly url: string; readonly redirect?: string } | undefined
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = { url: String(input), ...(init?.redirect !== undefined ? { redirect: init.redirect } : {}) }
      return new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com" } })
    }) as unknown as typeof fetch

    const probe = await probeRelay("https://relay.example.com", "access-secret")
    // The ping must not be able to hand the access key to another host.
    expect(seen?.redirect).toBe("manual")
    expect(probe).toMatchObject({ reachable: false, status: 302 })
  })

  test("a remote relay in plain http is never pinged", async () => {
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return jsonResponse({ control: "ping" }, 200)
    }) as unknown as typeof fetch

    const probe = await probeRelay("http://relay.example.com", "access-secret")
    expect(called).toBe(false)
    expect(probe).toMatchObject({ reachable: false, status: 0 })
  })

  test("an address that is not an address does not count", async () => {
    // The address goes into the avoid list that every relay receives, so an
    // exit must not be able to put anything there but an address.
    globalThis.fetch = (async () => {
      return jsonResponse({ egress: "not an address", runtime: "bun", instance: "i1" }, 200)
    }) as unknown as typeof fetch

    const probe = await probeRelay("https://relay.example.com", "access-secret")
    expect(probe.reachable).toBe(true)
    expect(probe.egress).toBeUndefined()
    expect(probe.runtime).toBe("bun")
  })

  test("a huge answer is not read whole", async () => {
    // The answer comes from the exit, which the user added: a body that
    // never ends would fill the memory until the timeout fires.
    const body = JSON.stringify({ egress: "1.2.3.4", padding: "x".repeat(2 * 1024 * 1024) })
    globalThis.fetch = (async () => {
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } })
    }) as unknown as typeof fetch

    const probe = await probeRelay("https://relay.example.com", "access-secret")
    // The body was cut, so it is not valid JSON any more: the answer is not
    // a relay, and nothing huge was kept.
    expect(probe.reachable).toBe(false)
  })

  test("a relay on this machine may be plain http", async () => {
    globalThis.fetch = (async () => {
      return jsonResponse({ control: "ping" }, 200)
    }) as unknown as typeof fetch

    const probe = await probeRelay("http://127.0.0.1:4321", "access-secret")
    expect(probe).toMatchObject({ reachable: true, status: 200 })
  })
})

describe("error redaction", () => {
  test("error messages never contain the raw token", async () => {
    const token = "tok-LEAK-ME"
    globalThis.fetch = (async () => {
      return jsonResponse({ error: { message: `bad token ${token}` } }, 500)
    }) as unknown as typeof fetch

    try {
      await inspectVercel({ token })
      throw new Error("expected inspectVercel to throw")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      expect(msg).not.toContain(token)
      expect(msg).toContain("***")
    }
  })
})
