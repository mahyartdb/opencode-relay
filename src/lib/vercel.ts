import { PLAN_LIMITS, type AccountPlan, egressAddress } from "./types.ts"
import { redact } from "./redact.ts"
import { isSafeRelayUrl, readBody } from "./routing.ts"

export interface VercelAccount {
  readonly token: string
  readonly teamId?: string
}

export interface DeployRelayInput {
  readonly account: VercelAccount
  /** Vercel project name, lowercase letters/digits/hyphens, max 63 chars. */
  readonly project: string
  /** Vercel region code, e.g. "fra1". */
  readonly region: string
  /** "bun" (default, recommended) or "node". */
  readonly runtime?: "bun" | "node"
  /** The relay's own access token; sent to the deployment as the RELAY_TOKEN env var. */
  readonly access: string
  /** The relay source file, deployed as api/relay.js */
  readonly relaySource: string
}

export interface DeployRelayResult {
  readonly id: string
  readonly project: string
  readonly url: string
  readonly region: string
}

export interface RelayProbe {
  readonly reachable: boolean
  readonly status: number
  /** How long the answer took, in milliseconds. */
  readonly ms: number
  readonly egress?: string
  readonly runtime?: string
  readonly instance?: string
}

const BASE = "https://api.vercel.com"
const DEPLOY_POLL_MS = 2000
const DEPLOY_TIMEOUT_MS = 120000
const DEPLOY_STATUS_TIMEOUT_MS = 15000
const PROBE_TIMEOUT_MS = 15000

/**
 * How much of a ping answer is read.
 *
 * The answer comes from the exit, which the user added: a body that never
 * ends would fill the memory until the timeout fires, and a body of a
 * megabyte of text would only be thrown away.
 */
const PROBE_BODY_LIMIT = 64 * 1024
const REQUEST_TIMEOUT_MS = 30000

function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

function withTeam(path: string, teamId?: string): string {
  if (!teamId) return path
  const join = path.includes("?") ? "&" : "?"
  return `${path}${join}teamId=${encodeURIComponent(teamId)}`
}

async function readErrorText(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as unknown
    if (data && typeof data === "object") {
      const rec = data as Record<string, unknown>
      const err = rec["error"]
      if (err && typeof err === "object") {
        const msg = (err as Record<string, unknown>)["message"]
        const code = (err as Record<string, unknown>)["code"]
        const parts = [typeof code === "string" ? code : undefined, typeof msg === "string" ? msg : undefined].filter(
          (x): x is string => !!x,
        )
        if (parts.length > 0) return parts.join(": ")
      }
      const msg = rec["message"]
      if (typeof msg === "string") return msg
      return JSON.stringify(data)
    }
    return String(data)
  } catch {
    try {
      return await res.text()
    } catch {
      return ""
    }
  }
}

async function vercelFetch(
  path: string,
  init: RequestInit & { token: string; secrets?: readonly (string | undefined)[]; timeoutMs?: number },
): Promise<Response> {
  const { token, secrets, timeoutMs = REQUEST_TIMEOUT_MS, ...rest } = init
  const headers = new Headers(rest.headers)
  const auth = authHeader(token)
  for (const [k, v] of Object.entries(auth)) headers.set(k, v)
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      ...rest,
      headers,
      signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new VercelError(redact(`Vercel request failed: ${msg}`, [token, ...(secrets ?? [])]))
  }
  return res
}

/**
 * Read an answer as JSON, with the secrets taken out of a failure.
 *
 * The parser's own message quotes the text it choked on, and that text is
 * whatever Vercel sent back: it could name the environment values the
 * deployment carried.
 */
async function readJson(response: Response, secrets: readonly (string | undefined)[]): Promise<unknown> {
  let text: string
  try {
    text = await response.text()
  } catch (err) {
    throw new Error(redact(`Vercel answer could not be read: ${err instanceof Error ? err.message : String(err)}`, secrets))
  }
  try {
    return JSON.parse(text) as unknown
  } catch (err) {
    throw new Error(
      redact(`Vercel answer was not JSON: ${err instanceof Error ? err.message : String(err)}`, secrets),
    )
  }
}

/**
 * A failure from the Vercel API.
 *
 * The status is carried with it, so the caller can tell a refused token from
 * an answer it did not like, without reading the wording.
 */
export class VercelError extends Error {
  constructor(
    message: string,
    /** The HTTP status Vercel answered with, when it answered at all. */
    readonly status?: number,
  ) {
    super(message)
    this.name = "VercelError"
  }
}

async function expectOk(
  res: Response,
  context: string,
  token: string,
  secrets: readonly (string | undefined)[] = [],
): Promise<void> {
  if (res.ok) return
  const allSecrets = [token, ...secrets]
  if (res.status === 401 || res.status === 403) {
    throw new VercelError(
      "Vercel refused the request (HTTP 401/403). Check the token and its permissions.",
      res.status,
    )
  }
  const detail = redact(await readErrorText(res), allSecrets)
  const suffix = detail ? `: ${detail}` : ""
  throw new VercelError(
    redact(`${context} (HTTP ${res.status})${suffix}`, allSecrets),
    res.status,
  )
}

function normalizeUrl(url: string): string {
  if (url.startsWith("https://") || url.startsWith("http://")) return url
  return `https://${url}`
}

function pickDeploymentUrl(alias: string[] | undefined, fallback: string | undefined): string {
  // A deployment URL carries a nine-character hash right before the domain,
  // optionally followed by further segments (a per-deployment branch or team
  // tag). Matching the hash against the domain anchor is what tells
  // `project-9charhash.vercel.app` apart from a project whose own name ends
  // in a shorter dash segment, which `-[a-z0-9]{9}-` alone would miss.
  const stable = alias?.find((a) => a.endsWith(".vercel.app") && !/-[a-z0-9]{9}(-[a-z0-9]+)?\.vercel\.app$/i.test(a))
  const chosen = stable ?? alias?.[0] ?? fallback
  if (!chosen) throw new Error("Vercel deployment did not return a URL.")
  return normalizeUrl(chosen)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function inspectVercel(account: VercelAccount): Promise<AccountPlan> {
  const { token, teamId } = account

  const teamsRes = await vercelFetch("/v2/teams", { token })
  if (teamsRes.status === 401 || teamsRes.status === 403) {
    throw new VercelError(
      "Vercel refused the request (HTTP 401/403). Check the token and its permissions.",
      teamsRes.status,
    )
  }
  await expectOk(teamsRes, "Failed to read Vercel teams", token)
  const teamsData = (await teamsRes.json()) as {
    teams?: Array<{ id?: string; slug?: string; billing?: { plan?: string } }>
  }
  const teams = teamsData.teams ?? []
  const team = teamId ? teams.find((t) => t.id === teamId) : teams[0]
  const plan = (team?.billing?.plan ?? "unknown").toLowerCase()
  const teamSlug = team?.slug ?? team?.id

  const projectsRes = await vercelFetch(withTeam("/v9/projects?limit=100", teamId), { token })
  if (projectsRes.status === 401 || projectsRes.status === 403) {
    // The status has to travel: the add-account path maps a refusal to a
    // token problem, and a plain error here would send the user to check
    // their network for a token that is simply bad.
    throw new VercelError(
      "Vercel refused the request (HTTP 401/403). Check the token and its permissions.",
      projectsRes.status,
    )
  }
  await expectOk(projectsRes, "Failed to read Vercel projects", token)
  const projectsData = (await projectsRes.json()) as {
    projects?: unknown[]
    pagination?: { next?: string | number | null }
  }
  const projects = projectsData.projects ?? []
  const next = projectsData.pagination?.next
  const projectsMore = next !== undefined && next !== null

  const limits = Object.hasOwn(PLAN_LIMITS, plan) ? PLAN_LIMITS[plan] : undefined

  const result: AccountPlan = {
    plan,
    teams: teams.length,
    projectsSampled: projects.length,
    projectsMore,
    ...(teamSlug ? { team: teamSlug } : {}),
    ...(limits ? { limits } : {}),
  }
  return result
}

export async function deployRelay(input: DeployRelayInput): Promise<DeployRelayResult> {
  const { account, project, region, access, relaySource } = input
  const runtime = input.runtime ?? "bun"
  const secrets = [account.token, access]

  const vercelJson =
    runtime === "bun"
      ? {
          bunVersion: "1.x",
          regions: [region],
          rewrites: [{ source: "/(.*)", destination: "/api/relay" }],
          functions: { "api/relay.js": { maxDuration: 300 } },
        }
      : {
          regions: [region],
          rewrites: [{ source: "/(.*)", destination: "/api/relay" }],
          functions: { "api/relay.js": { maxDuration: 300 } },
        }

  const packageJson =
    runtime === "node"
      ? { name: project, type: "module", private: true }
      : { name: project, private: true }

  const body = {
    name: project,
    target: "production",
    regions: [region],
    projectSettings: { framework: null, serverlessFunctionRegion: region },
    env: { RELAY_TOKEN: access },
    files: [
      { file: "api/relay.js", data: relaySource, encoding: "utf-8" },
      { file: "vercel.json", data: JSON.stringify(vercelJson), encoding: "utf-8" },
      { file: "package.json", data: JSON.stringify(packageJson), encoding: "utf-8" },
    ],
  }

  const createPath = withTeam("/v13/deployments?skipAutoDetectionConfirmation=1", account.teamId)
  const createRes = await vercelFetch(createPath, {
    token: account.token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    secrets,
  })
  await expectOk(createRes, "Failed to create Vercel deployment", account.token, secrets)
  // A body that is not JSON is read with a parser whose message quotes the
  // text it choked on, and that text could be anything Vercel sent back: the
  // secrets are taken out of it before it is shown.
  const created = (await readJson(createRes, secrets)) as {
    id?: string
    readyState?: string
    alias?: string[]
    url?: string
    errorMessage?: string
  }
  const id = created.id
  if (!id) throw new Error(redact("Vercel deployment response missing id.", secrets))

  const deadline = Date.now() + DEPLOY_TIMEOUT_MS
  let last = created
  // Inspect first, then wait: `created` already carries a readyState, so a
  // finished deployment must not be made to wait one poll interval.
  for (;;) {
    const state = last.readyState
    if (state === "READY") {
      const url = pickDeploymentUrl(last.alias, last.url)
      return { id, project, url, region }
    }
    if (state === "ERROR" || state === "CANCELED") {
      const msg = last.errorMessage ? redact(`: ${last.errorMessage}`, secrets) : ""
      throw new Error(redact(`Vercel deployment ${state.toLowerCase()}${msg}`, secrets))
    }
    if (Date.now() >= deadline) break
    await sleep(DEPLOY_POLL_MS)
    if (Date.now() >= deadline) break
    const statusPath = withTeam(`/v13/deployments/${encodeURIComponent(id)}`, account.teamId)
    const statusRes = await vercelFetch(statusPath, {
      token: account.token,
      secrets,
      timeoutMs: DEPLOY_STATUS_TIMEOUT_MS,
    })
    await expectOk(statusRes, "Failed to read Vercel deployment status", account.token, secrets)
    last = (await readJson(statusRes, secrets)) as typeof created
  }
  throw new Error("Vercel deployment timed out after 120 seconds.")
}

export async function deleteVercelProject(account: VercelAccount, project: string): Promise<void> {
  const path = withTeam(`/v9/projects/${encodeURIComponent(project)}`, account.teamId)
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      method: "DELETE",
      headers: authHeader(account.token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(redact(`Failed to delete Vercel project: ${msg}`, [account.token]))
  }
  if (res.status === 404) return
  await expectOk(res, "Failed to delete Vercel project", account.token)
}

export async function probeRelay(url: string, access: string): Promise<RelayProbe> {
  const started = performance.now()
  const elapsed = () => Math.max(0, Math.round(performance.now() - started))
  // The access key travels in a header, so the ping must not be able to hand
  // it to another host: a redirect is not followed, and a remote address has
  // to be one that carries the key in the clear.
  if (!isSafeRelayUrl(url)) {
    return { reachable: false, status: 0, ms: elapsed() }
  }
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "x-relay-key": access,
        "x-relay-control": "ping",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    const status = res.status
    // A redirect is not a relay answering: following it would carry the
    // access key to a host the user never chose.
    if (status >= 300 && status < 400) {
      return { reachable: false, status, ms: elapsed() }
    }
    if (!res.ok) {
      return { reachable: false, status, ms: elapsed() }
    }
    let data: unknown
    try {
      // The body is read through a cap, not with `json()`: an exit the user
      // added answers this ping, and a body that never ends would fill the
      // memory until the timeout fires.
      const text = await readBody(res, 2000, PROBE_BODY_LIMIT)
      data = text === undefined ? undefined : (JSON.parse(text) as unknown)
    } catch {
      data = undefined
    }
    // A 2xx alone is not a relay: a captive portal or an HTML error page
    // answers 200 as well. The ping must be a JSON object to count.
    if (!(data && typeof data === "object") || Array.isArray(data)) {
      return { reachable: false, status, ms: elapsed() }
    }
    const obj = data as Record<string, unknown>
    // The three strings are what the exit says about itself. The address only
    // counts when it looks like one, and they are cut to a length the menu
    // can show: an exit controls them, and they are stored and displayed as
    // they are.
    const egress = egressAddress(typeof obj?.["egress"] === "string" ? obj["egress"] : undefined)
    const runtime = typeof obj?.["runtime"] === "string" ? (obj["runtime"] as string).slice(0, 64) : undefined
    const instance = typeof obj?.["instance"] === "string" ? (obj["instance"] as string).slice(0, 64) : undefined
    return {
      reachable: true,
      status,
      ms: elapsed(),
      ...(egress !== undefined ? { egress } : {}),
      ...(runtime !== undefined ? { runtime } : {}),
      ...(instance !== undefined ? { instance } : {}),
    }
  } catch {
    return { reachable: false, status: 0, ms: elapsed() }
  }
}
