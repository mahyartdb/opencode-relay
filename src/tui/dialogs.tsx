/**
 * The dialog flows of the relay plugin.
 *
 * Every flow is a short conversation with the user and ends in one RPC call
 * and one toast, so nothing ever happens silently. A rejection is caught
 * here: an unhandled rejection inside a plugin takes the whole TUI with it.
 */
import { For } from "solid-js"
import type { Context, DialogSelectOption } from "@opencode/plugin/tui/context"
import { Relay } from "../rpc.ts"
import { REGIONS } from "../lib/types.ts"
import { publishModels, publishStatus, type RelayModel, type RelayStatus } from "./state.ts"

/** The typed client for the relay contract, so both ends speak the same shapes. */
export function relayClient(context: Context) {
  return context.client.rpc(Relay)
}

/** The type of that client, so no other module has to spell it out. */
export type RelayClient = ReturnType<typeof relayClient>

/** What the main menu can do. */
type MenuAction =
  | "toggle"
  | "models"
  | "relay"
  | "deploy"
  | "track-relay"
  | "add-account"
  | "remove-account"
  | "remove-relay"
  | "test"
  | "update"

/** One model in the picker, or the way out of it. */
type ModelChoice = { readonly kind: "model"; readonly id: string } | { readonly kind: "done" }

/** The answer of a refresh: the new state, or the reason there is none. */
export type Refresh =
  | { readonly ok: true; readonly status: RelayStatus }
  | { readonly ok: false; readonly error: unknown }

/** The reason a call failed, in words the user can act on. */
function describeError(error: unknown): string {
  if (typeof error === "string") return error
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string")
    return error.message
  return "The relay plugin did not answer."
}

/** Report a failure to the user; nothing else is allowed to fail silently. */
export function reportError(context: Context, title: string, error: unknown): void {
  context.ui.toast.show({ title, message: describeError(error), variant: "error" })
}

/** Run one RPC call and turn a rejection into a toast instead of a crash. */
async function callRpc<T>(context: Context, title: string, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run()
  } catch (error) {
    reportError(context, title, error)
    return undefined
  }
}

/**
 * Read the current routing state and publish it to the pill.
 *
 * The model list is only fetched when the number of routed models depends on
 * it, so the common case stays one round trip.
 */
export async function refreshStatus(context: Context, client: RelayClient): Promise<Refresh> {
  try {
    const status = await client.status({})
    publishStatus(status)
    await refreshModels(context, client, status)
    return { ok: true, status }
  } catch (error) {
    return { ok: false, error }
  }
}

/** Fetch the model list, but only when the routed count depends on it. */
async function refreshModels(
  context: Context,
  client: RelayClient,
  status: RelayStatus,
): Promise<void> {
  if (status.selection !== "all" && status.selection !== "free") return
  try {
    const models = await client.models({})
    publishModels(models.models)
  } catch (error) {
    // The count in the pill is a nicety, but a missing model list is not the
    // same as an empty one: the user has to hear that nothing is known.
    reportError(context, "Relay", error)
  }
}

/** What the menu says about the current selection. */
function describeSelection(status: RelayStatus): string {
  if (status.selection === "all") return "Now: every model"
  if (status.selection === "free") return "Now: the free models only"
  if (status.customModels.length === 0) return "Now: nothing is routed"
  const count = status.customModels.length
  return `Now: ${count} chosen model${count === 1 ? "" : "s"}`
}

/** The main menu, with the entries that would do nothing left out. */
function menuOptions(status: RelayStatus): DialogSelectOption<MenuAction>[] {
  const options: DialogSelectOption<MenuAction>[] = [
    {
      title: status.enabled ? "Turn routing off" : "Turn routing on",
      value: "toggle",
      description: status.enabled ? "Requests go direct again" : "Requests go through the relay",
    },
    { title: "Choose models to route", value: "models", description: describeSelection(status) },
    {
      title: "Choose a relay",
      value: "relay",
      description:
        status.relays.length === 0
          ? "No relay yet"
          : status.activeRelay
            ? `Active: ${status.activeRelay.name}`
            : "No relay is active",
    },
    { title: "Deploy a relay", value: "deploy" },
    { title: "Track an existing relay", value: "track-relay" },
    { title: "Add a Vercel account", value: "add-account" },
  ]
  if (status.accounts.length > 0) options.push({ title: "Remove an account", value: "remove-account" })
  if (status.relays.length > 0) options.push({ title: "Remove a relay", value: "remove-relay" })
  if (status.activeRelay)
    options.push({ title: "Test the active relay", value: "test", description: status.activeRelay.name })
  if (status.activeRelay)
    options.push({
      title: "Update the active relay",
      value: "update",
      description: "Redeploy the current code over the same relay",
    })
  return options
}

/** Open the main menu and run whatever the user picked. */
export async function openRelayMenu(context: Context, client: RelayClient): Promise<void> {
  const refreshed = await refreshStatus(context, client)
  if (!refreshed.ok) {
    reportError(context, "Relay", refreshed.error)
    return
  }
  const status = refreshed.status
  const choice = await context.ui.dialog.select<MenuAction>({ title: "Relay", options: menuOptions(status) })
  if (choice === undefined) return
  switch (choice) {
    case "toggle":
      return toggleRouting(context, client, status)
    case "models":
      return chooseModels(context, client, status)
    case "relay":
      return chooseRelay(context, client, status)
    case "deploy":
      return deployRelay(context, client, status)
    case "track-relay":
      return trackRelay(context, client)
    case "update":
      return updateRelay(context, client, status)
    case "add-account":
      return addAccount(context, client)
    case "remove-account":
      return removeAccount(context, client, status)
    case "remove-relay":
      return removeRelay(context, client, status)
    case "test":
      return testRelay(context, client, status)
  }
}

/** Turn routing on or off. */
async function toggleRouting(context: Context, client: RelayClient, status: RelayStatus): Promise<void> {
  const enabled = !status.enabled
  const result = await callRpc(context, "Relay", () => client.setEnabled({ enabled }))
  if (!result) return
  const refreshed = await refreshStatus(context, client)
  const note = refreshed.ok ? refreshed.status.note : undefined
  const summary = enabled ? "Routing is on." : "Routing is off."
  context.ui.toast.show({
    title: "Relay",
    message: note ? `${summary} ${note}` : summary,
    variant: "success",
  })
}

/** Let the user say which models go through the relay. */
async function chooseModels(context: Context, client: RelayClient, status: RelayStatus): Promise<void> {
  const result = await callRpc(context, "Relay", () => client.models({}))
  if (!result) return
  const models = result.models
  publishModels(models)
  const free = models.filter((model) => model.free)
  const mode = await context.ui.dialog.select<"all" | "free" | "custom">({
    title: `Route models (${free.length} of ${models.length} are free)`,
    options: [
      { title: "Route every model", value: "all", description: `${models.length} models` },
      { title: "Route only the free models", value: "free", description: `${free.length} models` },
      { title: "Choose models one by one", value: "custom", description: "Pick exactly what is routed" },
    ],
  })
  if (mode === undefined) return
  if (mode === "all" || mode === "free") {
    await setSelection(context, client, { selection: mode })
    return
  }
  await pickModels(context, client, models, status.customModels)
}

/** Ask about one model at a time until the user says they are done. */
async function pickModels(
  context: Context,
  client: RelayClient,
  models: readonly RelayModel[],
  initial: readonly string[],
): Promise<void> {
  const picked = new Set(initial)
  let current: ModelChoice | undefined
  for (;;) {
    const options: DialogSelectOption<ModelChoice>[] = models.map((model): DialogSelectOption<ModelChoice> => {
      const cost = model.free ? "free" : "paid"
      const state = picked.has(model.id) ? "routed" : "not routed"
      return {
        title: model.name,
        value: { kind: "model", id: model.id },
        description: `${model.id} · ${cost} · ${state}`,
      }
    })
    options.push({ title: "Done", value: { kind: "done" }, description: "Save this selection" })
    const choice = await context.ui.dialog.select<ModelChoice>({
      title: "Choose models to route",
      options,
      current,
    })
    if (choice === undefined) return
    if (choice.kind === "done") break
    current = choice
    const model = models.find((item) => item.id === choice.id)
    if (!model) continue
    const routed = picked.has(model.id)
    const answer = await context.ui.dialog.confirm({
      title: routed ? `Stop routing ${model.name}?` : `Route ${model.name}?`,
      message: `${model.id} — ${model.free ? "runs on the free allowance" : "costs money per token"}.`,
      label: routed ? { confirm: "Stop routing", cancel: "Keep it" } : { confirm: "Route it", cancel: "Skip" },
    })
    if (answer === undefined) return
    if (answer) picked.add(model.id)
    else picked.delete(model.id)
  }
  await setSelection(context, client, { selection: "custom", models: [...picked] })
}

/** Tell the server which models are routed. */
async function setSelection(
  context: Context,
  client: RelayClient,
  input: { readonly selection: "all" | "free" | "custom"; readonly models?: readonly string[] },
): Promise<void> {
  const result = await callRpc(context, "Relay", () => client.setSelection(input))
  if (!result) return
  context.ui.toast.show({ title: "Relay", message: "The routed models changed.", variant: "success" })
  await refreshStatus(context, client)
}

/** Switch to another relay. */
async function chooseRelay(context: Context, client: RelayClient, status: RelayStatus): Promise<void> {
  if (status.relays.length === 0) {
    context.ui.toast.show({ title: "Relay", message: "There is no relay yet. Deploy one first.", variant: "warning" })
    return
  }
  const choice = await context.ui.dialog.select<{ readonly id: string; readonly name: string }>({
    title: "Choose a relay",
    options: status.relays.map((relay) => ({
      title: relay.name,
      value: { id: relay.id, name: relay.name },
      description: `${relay.regionLabel} · ${relay.status}`,
    })),
    current: status.activeRelay ? { id: status.activeRelay.id, name: status.activeRelay.name } : undefined,
  })
  if (choice === undefined) return
  const result = await callRpc(context, "Relay", () => client.useRelay({ id: choice.id }))
  if (!result) return
  context.ui.toast.show({ title: "Relay", message: `${choice.name} is the active relay.`, variant: "success" })
  await refreshStatus(context, client)
}

/** Deploy a new relay to a region. */
async function deployRelay(context: Context, client: RelayClient, status: RelayStatus): Promise<void> {
  if (status.accounts.length === 0) {
    context.ui.toast.show({ title: "Relay", message: "Add a Vercel account first.", variant: "warning" })
    return
  }
  const account = await context.ui.dialog.select<{ readonly id: string; readonly name: string }>({
    title: "Deploy with which account?",
    options: status.accounts.map((item) => ({
      title: item.name,
      value: { id: item.id, name: item.name },
      description: item.plan ? `Plan: ${item.plan}` : undefined,
    })),
  })
  if (account === undefined) return
  const region = await context.ui.dialog.select<{ readonly code: string; readonly label: string }>({
    title: "Deploy to which region?",
    options: REGIONS.map((item) => ({
      title: item.label,
      value: { code: item.code, label: item.label },
      description: item.code,
    })),
  })
  if (region === undefined) return
  const deployed = await callRpc(context, "Relay", () =>
    client.deployRelay({ accountId: account.id, region: region.code }),
  )
  if (!deployed) return
  context.ui.toast.show({
    title: "Relay",
    message: `${deployed.name} is deployed in ${deployed.regionLabel}.`,
    variant: "success",
  })
  await refreshStatus(context, client)
  showRelayCard(context, deployed.name, [deployed.url, deployed.regionLabel])
}

/**
 * Track a relay that already exists.
 *
 * A relay deployed by hand, or by another tool, can be used as it is: the
 * plugin only needs its address and the token it requires.
 */
async function trackRelay(context: Context, client: RelayClient): Promise<void> {
  const name = await context.ui.dialog.prompt({
    title: "Name this relay",
    description: "A name you will recognize later.",
    placeholder: "my relay",
  })
  if (name === undefined) return
  const url = await context.ui.dialog.prompt({
    title: "Where does it answer?",
    description: "The address of the relay, for example https://my-relay.vercel.app.",
    placeholder: "https://my-relay.vercel.app",
  })
  if (url === undefined) return
  const access = await context.ui.dialog.prompt({
    title: "Its access token",
    description: "The token the relay requires in x-relay-key.",
    placeholder: "access token",
  })
  if (access === undefined) return
  const added = await callRpc(context, "Relay", () =>
    client.addRelay({ name: name.trim(), url: url.trim(), access: access.trim() }),
  )
  if (!added) return
  context.ui.toast.show({
    title: "Relay",
    message: added.reachable ? `${added.name} is tracked.` : `${added.name} is tracked but did not answer.`,
    variant: added.reachable ? "success" : "warning",
  })
  await refreshStatus(context, client)
}

/** Redeploy the current relay code over the relay that is already running. */
async function updateRelay(context: Context, client: RelayClient, status: RelayStatus): Promise<void> {
  const relay = status.activeRelay
  if (!relay) return
  const updated = await callRpc(context, "Relay", () => client.updateRelay({ id: relay.id }))
  if (!updated) return
  context.ui.toast.show({
    title: "Relay",
    message: updated.reachable
      ? `${relay.name} was redeployed and answers.`
      : `${relay.name} was redeployed but did not answer.`,
    variant: updated.reachable ? "success" : "warning",
  })
  await refreshStatus(context, client)
}

/** Add a Vercel account, so a relay can be deployed later. */
async function addAccount(context: Context, client: RelayClient): Promise<void> {
  const name = await context.ui.dialog.prompt({
    title: "Name this account",
    description: "A name you will recognize later, for example “personal”.",
    placeholder: "personal",
  })
  if (name === undefined) return
  const token = await context.ui.dialog.prompt({
    title: "Vercel token",
    description: "Create one in Vercel under Settings → Tokens.",
    placeholder: "vercel token",
  })
  if (token === undefined) return
  if (name.trim() === "" || token.trim() === "") {
    context.ui.toast.show({ title: "Relay", message: "The name and the token are both needed.", variant: "error" })
    return
  }
  const added = await callRpc(context, "Relay", () => client.addAccount({ name: name.trim(), token: token.trim() }))
  if (!added) return
  context.ui.toast.show({
    title: "Relay",
    message: `${added.name} added (${added.plan ?? "plan unknown"}).`,
    variant: "success",
  })
  await refreshStatus(context, client)
}

/** Forget an account. The relays deployed with it stay. */
async function removeAccount(context: Context, client: RelayClient, status: RelayStatus): Promise<void> {
  const choice = await context.ui.dialog.select<{ readonly id: string; readonly name: string }>({
    title: "Remove which account?",
    options: status.accounts.map((item) => ({
      title: item.name,
      value: { id: item.id, name: item.name },
      description: item.plan ? `Plan: ${item.plan}` : undefined,
    })),
  })
  if (choice === undefined) return
  const result = await callRpc(context, "Relay", () => client.removeAccount({ id: choice.id }))
  if (!result) return
  context.ui.toast.show({ title: "Relay", message: `${choice.name} removed.`, variant: "success" })
  await refreshStatus(context, client)
}

/** Forget a relay. The Vercel project it runs on is kept. */
async function removeRelay(context: Context, client: RelayClient, status: RelayStatus): Promise<void> {
  const choice = await context.ui.dialog.select<{ readonly id: string; readonly name: string }>({
    title: "Remove which relay?",
    options: status.relays.map((relay) => ({
      title: relay.name,
      value: { id: relay.id, name: relay.name },
      description: `${relay.regionLabel} · ${relay.status}`,
    })),
  })
  if (choice === undefined) return
  const withProject = await context.ui.dialog.confirm({
    title: `Delete the Vercel project of ${choice.name} too?`,
    message:
      "The project is what runs the relay, so deleting it stops the relay and frees its deployment. Choose no to forget the relay and leave the project running.",
    label: { confirm: "Delete it as well", cancel: "Leave it running" },
  })
  if (withProject === undefined) return
  const result = await callRpc(context, "Relay", () =>
    client.removeRelay({ id: choice.id, deleteProject: withProject }),
  )
  if (!result) return
  context.ui.toast.show({
    title: "Relay",
    message: withProject
      ? `${choice.name} and its Vercel project were removed.`
      : `${choice.name} was removed. Its Vercel project is still running.`,
    variant: "success",
  })
  await refreshStatus(context, client)
}

/** Ask the relay whether it answers, and from where. */
async function testRelay(context: Context, client: RelayClient, status: RelayStatus): Promise<void> {
  const relay = status.activeRelay
  if (!relay) return
  const result = await callRpc(context, "Relay", () => client.testRelay({ id: relay.id }))
  if (!result) return
  const lines = [
    result.reachable ? "The relay answered." : "The relay did not answer.",
    `HTTP ${result.status}`,
    ...(result.egress ? [`Egress: ${result.egress}`] : []),
    ...(result.runtime ? [`Runtime: ${result.runtime}`] : []),
  ]
  await context.ui.dialog.alert({ title: `Test ${relay.name}`, message: lines.join("\n") })
}

/**
 * A short card about one relay.
 *
 * The built-in dialogs only take strings, and a relay deserves a little more
 * room than a toast gives it: the address and the region are what the user
 * wants to see after a deployment.
 */
function RelayCard(props: { readonly title: string; readonly lines: readonly string[]; readonly fg: string }) {
  return (
    <box flexDirection="column" gap={1} paddingLeft={1} paddingRight={1}>
      <text fg={props.fg}>{props.title}</text>
      <For each={props.lines}>
        {(line) => <text fg={props.fg}>{line}</text>}
      </For>
      <text fg={props.fg}>esc to close</text>
    </box>
  )
}

/** Show the relay card; it is read-only, so any key that closes the dialog will do. */
function showRelayCard(context: Context, title: string, lines: readonly string[]): void {
  const fg = context.themeMode === "dark" ? "#e6e6e6" : "#1c1c1c"
  context.ui.dialog.show(() => <RelayCard title={title} lines={lines} fg={fg} />)
}
