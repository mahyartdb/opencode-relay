/**
 * The dialog flows of the relay plugin.
 *
 * The menu stays open: every action ends by asking what to do next, so a
 * change does not throw the user out of the plugin. A slow action says what
 * it is doing while it does it, and the lists offer the common next steps as
 * key bindings, so the mouse is not the only way through.
 *
 * Every flow is a short conversation with the user and ends in one RPC call
 * and one toast, so nothing ever happens silently. A rejection is caught
 * here: an unhandled rejection inside a plugin takes the whole TUI with it.
 */
import { createSignal, onCleanup } from "solid-js"
import type { Context, DialogSelectAction, DialogSelectOption } from "@opencode/plugin/tui/context"
import { Relay } from "../rpc.ts"
import { REGIONS, STRATEGIES, STRATEGY_LABELS, type Strategy } from "../lib/types.ts"
import { menuOptions, relayList, type MenuAction, type RelayChoice } from "./present.ts"
import { publishModels, publishStatus, type RelayModel, type RelayStatus } from "./state.ts"

/** The typed client for the relay contract, so both ends speak the same shapes. */
export function relayClient(context: Context) {
  return context.client.rpc(Relay)
}

/** The type of that client, so no other module has to spell it out. */
export type RelayClient = ReturnType<typeof relayClient>

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

/**
 * The dialog that says a slow thing is happening.
 *
 * The dots move so it is clear the plugin is still working and has not
 * stopped. Esc closes the dialog but not the work: a deployment that is
 * already under way goes on by itself.
 */
function Working(props: { readonly message: string }) {
  const [dots, setDots] = createSignal("")
  const timer = setInterval(() => setDots((current) => (current.length >= 3 ? "" : `${current}.`)), 350)
  onCleanup(() => clearInterval(timer))
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <text>{props.message}{dots()}</text>
      <text fg="#6c6c6c">esc to close this</text>
    </box>
  )
}

/**
 * Runs something slow with a dialog that says what is happening.
 *
 * A deployment takes a while, and a dialog that disappears leaves the user
 * wondering whether anything is going on at all.
 */
async function withWorking<T>(context: Context, message: string, run: () => Promise<T>): Promise<T> {
  let closed = false
  context.ui.dialog.show(
    () => <Working message={message} />,
    () => {
      closed = true
    },
  )
  try {
    return await run()
  } finally {
    // The dialog may already be gone: the user closed it, or another dialog
    // took its place, and closing that one by mistake would be worse.
    if (!closed) context.ui.dialog.clear()
  }
}

/**
 * The menu, and it stays open.
 *
 * Every action ends by asking what to do next, so a change does not throw the
 * user out of the plugin and back to the prompt. The active relay can be
 * tested from here with t, without opening another screen.
 */
export async function openRelayMenu(context: Context, client: RelayClient): Promise<void> {
  for (;;) {
    const refreshed = await refreshStatus(context, client)
    if (!refreshed.ok) {
      reportError(context, "Relay", refreshed.error)
      return
    }
    const active = refreshed.status.activeRelay
    const choice = await context.ui.dialog.select<MenuAction>({
      title: "Relay",
      options: menuOptions(refreshed.status),
      ...(active ? { actions: [testActiveAction(context, client, active)] } : {}),
    })
    if (choice === undefined || choice === "close") return
    await runAction(context, client, refreshed.status, choice)
  }
}

/** Runs one entry of the menu. */
async function runAction(
  context: Context,
  client: RelayClient,
  status: RelayStatus,
  choice: MenuAction,
): Promise<void> {
  switch (choice) {
    case "toggle":
      return toggleRouting(context, client, status)
    case "models":
      return chooseModels(context, client, status)
    case "strategy":
      return chooseStrategy(context, client, status)
    case "relay":
      return chooseRelay(context, client, status)
    case "deploy":
      return deployRelay(context, client, status)
    case "track-relay":
      return trackRelay(context, client)
    case "add-account":
      return addAccount(context, client)
    case "remove-account":
      return removeAccount(context, client, status)
    case "remove-relay":
      return removeRelay(context, client, status)
    case "test":
      return status.activeRelay ? quickTest(context, client, status.activeRelay) : undefined
    case "update":
      return status.activeRelay ? updateRelay(context, client, status.activeRelay.id) : undefined
    case "restore":
      return restoreExhausted(context, client)
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

/** Choose how the relays are used. */
async function chooseStrategy(context: Context, client: RelayClient, status: RelayStatus): Promise<void> {
  const options = STRATEGIES.map(
    (strategy): DialogSelectOption<Strategy> => ({
      title: STRATEGY_LABELS[strategy].title,
      value: strategy,
      description: STRATEGY_LABELS[strategy].description,
    }),
  )
  const choice = await context.ui.dialog.select<Strategy>({
    title: "How should the relays be used?",
    options,
    current: status.strategy,
  })
  if (choice === undefined) return
  const result = await callRpc(context, "Relay", () => client.setStrategy({ strategy: choice }))
  if (!result) return
  context.ui.toast.show({
    title: "Relay",
    message: `Now: ${STRATEGY_LABELS[choice].title.toLowerCase()}.`,
    variant: "success",
  })
  await refreshStatus(context, client)
}

/** Bring the relays whose allowance is gone back into use. */
async function restoreExhausted(context: Context, client: RelayClient): Promise<void> {
  const result = await callRpc(context, "Relay", () => client.resetExhausted({}))
  if (!result) return
  context.ui.toast.show({
    title: "Relay",
    message:
      result.restored.length === 0
        ? "No relay was out of use."
        : `${result.restored.length} relay${result.restored.length === 1 ? " is" : "s are"} back in use.`,
    variant: "success",
  })
  await refreshStatus(context, client)
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
  const unchanged = () =>
    picked.size === initial.length && initial.every((id) => picked.has(id))
  let current: { readonly kind: "model"; readonly id: string } | undefined
  for (;;) {
    const options: DialogSelectOption<
      { readonly kind: "model"; readonly id: string } | { readonly kind: "done" }
    >[] = models.map((model) => ({
      title: model.name,
      value: { kind: "model", id: model.id },
      description: `${model.id} - ${model.free ? "free" : "paid"} - ${picked.has(model.id) ? "routed" : "not routed"}`,
    }))
    options.push({ title: "Done", value: { kind: "done" }, description: "Save this selection" })
    const choice = await context.ui.dialog.select({
      title: `Choose models to route (${picked.size} picked)`,
      options,
      current,
    })
    if (choice === undefined) {
      // Esc leaves the list. If that would throw work away, the user is asked
      // first: losing a long selection to one keystroke is not acceptable.
      if (unchanged()) return
      const discard = await context.ui.dialog.confirm({
        title: "Discard these model changes?",
        message: "The selection has changed. Save it with Done, or leave it as it was.",
        label: { confirm: "Discard changes", cancel: "Keep editing" },
      })
      if (discard) return
      continue
    }
    if (choice.kind === "done") break
    current = choice
    const model = models.find((item) => item.id === choice.id)
    if (!model) continue
    const routed = picked.has(model.id)
    const answer = await context.ui.dialog.confirm({
      title: routed ? `Stop routing ${model.name}?` : `Route ${model.name}?`,
      message: `${model.id} - ${model.free ? "runs on the free allowance" : "costs money per token"}.`,
      label: routed ? { confirm: "Stop routing", cancel: "Keep it" } : { confirm: "Route it", cancel: "Skip" },
    })
    // Backing out of the question returns to the list with the work so far.
    if (answer === undefined) continue
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
  const count = result.customModels.length
  const message =
    result.selection === "all"
      ? "Every model is routed."
      : result.selection === "free"
        ? "The free models are routed."
        : count === 0
          ? "No model is routed. Choose at least one."
          : `${count} model${count === 1 ? " is" : "s are"} routed.`
  context.ui.toast.show({
    title: "Relay",
    message,
    variant: result.selection === "custom" && count === 0 ? "warning" : "success",
  })
  await refreshStatus(context, client)
}

/**
 * Report whether a relay answers, in a toast that leaves the list open.
 *
 * A test is a look, not a move: it must not throw the user out of the list
 * they are choosing from, so it never opens a dialog of its own. The time it
 * took is part of the answer, because a relay that answers slowly is a relay
 * the user may not want to keep.
 */
async function quickTest(context: Context, client: RelayClient, relay: RelayChoice): Promise<void> {
  context.ui.toast.show({ title: "Relay", message: `Testing ${relay.name}...`, variant: "info" })
  const result = await callRpc(context, "Relay", () => client.testRelay({ id: relay.id }))
  if (!result) return
  const parts = [
    result.reachable ? `${relay.name} answered` : `${relay.name} did not answer`,
    result.reachable
      ? `${result.ms} ms`
      : result.status > 0
        ? `HTTP ${result.status}`
        : "no answer",
    ...(result.egress ? [result.egress] : []),
  ]
  context.ui.toast.show({
    title: "Relay",
    message: parts.join(" · "),
    variant: result.reachable ? "success" : "warning",
  })
  // The probe also records whether the relay is reachable, so the list and the
  // pill must show the answer the test just found.
  void refreshStatus(context, client)
}

/** The key binding that tests the relay the cursor is on. */
function testAction(context: Context, client: RelayClient): DialogSelectAction<RelayChoice> {
  return {
    bind: "t",
    title: "test",
    side: "left",
    selection: "required",
    onTrigger: (value) => {
      void quickTest(context, client, value)
    },
  }
}

/** The key binding that tests the chosen relay from the main menu. */
function testActiveAction(
  context: Context,
  client: RelayClient,
  relay: RelayChoice,
): DialogSelectAction<MenuAction> {
  return {
    bind: "t",
    title: "test",
    side: "left",
    selection: "none",
    onTrigger: () => {
      void quickTest(context, client, relay)
    },
  }
}

/** Switch to another relay. */
async function chooseRelay(context: Context, client: RelayClient, status: RelayStatus): Promise<void> {
  if (status.relays.length === 0) {
    context.ui.toast.show({
      title: "Relay",
      message: "There is no relay yet. Deploy one first.",
      variant: "warning",
    })
    return
  }
  const choice = await context.ui.dialog.select<RelayChoice>({
    title: "Choose a relay",
    options: relayList(status),
    ...(status.activeRelay ? { current: { id: status.activeRelay.id, name: status.activeRelay.name } } : {}),
    actions: [testAction(context, client)],
  })
  if (choice === undefined) return
  const result = await callRpc(context, "Relay", () => client.useRelay({ id: choice.id }))
  if (!result) return
  // Choosing a relay that does not answer is allowed, but the user is told
  // what it means right away instead of wondering why nothing is routed.
  const relay = status.relays.find((item) => item.id === choice.id)
  const quiet = relay?.status === "unreachable"
  context.ui.toast.show({
    title: "Relay",
    message: quiet
      ? `${choice.name} is the active relay, but it is not answering: requests go direct until it does.`
      : `${choice.name} is the active relay.`,
    variant: quiet ? "warning" : "success",
    ...(quiet ? { duration: 8000 } : {}),
  })
  await refreshStatus(context, client)
}

/** Deploy a new relay to a region. */
async function deployRelay(context: Context, client: RelayClient, status: RelayStatus): Promise<void> {
  if (status.accounts.length === 0) {
    context.ui.toast.show({ title: "Relay", message: "Add a Vercel account first.", variant: "warning" })
    return
  }
  // One account is no choice at all, so the only account is used without a
  // question and the conversation goes straight to the region.
  const only = status.accounts.length === 1 ? status.accounts[0] : undefined
  const account =
    only ?? (await context.ui.dialog.select<{ readonly id: string; readonly name: string }>({
      title: "Deploy with which account?",
      options: status.accounts.map((item) => ({
        title: item.name,
        value: { id: item.id, name: item.name },
        description: item.plan ? `Plan: ${item.plan}` : undefined,
      })),
    }))
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
  const deployed = await withWorking(context, `Deploying a relay in ${region.label}`, () =>
    callRpc(context, "Relay", () => client.deployRelay({ accountId: account.id, region: region.code })),
  )
  if (!deployed) return
  context.ui.toast.show({
    title: "Relay",
    message: `${deployed.name} is deployed in ${deployed.regionLabel}: ${deployed.url}`,
    variant: "success",
    duration: 8000,
  })
  await refreshStatus(context, client)
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
  const region = await context.ui.dialog.select<string>({
    title: "Where does it run?",
    options: [
      { title: "I am not sure", value: "", description: "No region label" },
      ...REGIONS.map((item) => ({ title: item.label, value: item.code, description: item.code })),
    ],
  })
  if (region === undefined) return
  const access = await context.ui.dialog.prompt({
    title: "Its access token",
    description: "The token the relay requires in x-relay-key.",
    placeholder: "access token",
  })
  if (access === undefined) return
  if (name.trim() === "" || url.trim() === "" || access.trim() === "") {
    context.ui.toast.show({
      title: "Relay",
      message: "A name, an address and an access token are all needed.",
      variant: "error",
    })
    return
  }
  const added = await withWorking(context, `Checking ${name.trim()}`, () =>
    callRpc(context, "Relay", () =>
      client.addRelay({
        name: name.trim(),
        url: url.trim(),
        access: access.trim(),
        ...(region.length > 0 ? { region } : {}),
      }),
    ),
  )
  if (!added) return
  context.ui.toast.show({
    title: "Relay",
    message: added.reachable ? `${added.name} is tracked.` : `${added.name} is tracked but did not answer.`,
    variant: added.reachable ? "success" : "warning",
  })
  await refreshStatus(context, client)
}

/** Add a Vercel account, so a relay can be deployed later. */
async function addAccount(context: Context, client: RelayClient): Promise<void> {
  const name = await context.ui.dialog.prompt({
    title: "Name this account",
    description: "A name you will recognize later, for example \"personal\".",
    placeholder: "personal",
  })
  if (name === undefined) return
  const token = await context.ui.dialog.prompt({
    title: "Vercel token",
    description: "Create one in Vercel under Settings -> Tokens.",
    placeholder: "vercel token",
  })
  if (token === undefined) return
  if (name.trim() === "" || token.trim() === "") {
    context.ui.toast.show({ title: "Relay", message: "The name and the token are both needed.", variant: "error" })
    return
  }
  const added = await withWorking(context, "Checking the Vercel token", () =>
    callRpc(context, "Relay", () => client.addAccount({ name: name.trim(), token: token.trim() })),
  )
  if (!added) return
  context.ui.toast.show({
    title: "Relay",
    message: `${added.name} added (${added.plan ?? "plan unknown"}).`,
    variant: "success",
  })
  await refreshStatus(context, client)
}

/** Forget an account. The relays deployed with it stay: they run on their own. */
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
  const sure = await context.ui.dialog.confirm({
    title: `Remove ${choice.name}?`,
    message:
      "The relays deployed with this account keep running. Only the stored token and the name are forgotten.",
    label: { confirm: "Remove it", cancel: "Keep it" },
  })
  if (!sure) return
  const result = await callRpc(context, "Relay", () => client.removeAccount({ id: choice.id }))
  if (!result) return
  context.ui.toast.show({ title: "Relay", message: `${choice.name} removed.`, variant: "success" })
  await refreshStatus(context, client)
}

/** Forget a relay. The Vercel project it runs on is kept unless it is asked for. */
async function removeRelay(context: Context, client: RelayClient, status: RelayStatus): Promise<void> {
  if (status.relays.length === 0) return
  const choice = await context.ui.dialog.select<RelayChoice>({
    title: "Remove which relay?",
    options: relayList(status),
    actions: [testAction(context, client)],
  })
  if (choice === undefined) return
  // A relay that was tracked by hand has no project of ours to delete, so the
  // question would be about something that does not exist.
  const project = status.relays.find((relay) => relay.id === choice.id)?.project ?? ""
  let withProject = false
  if (project.length > 0) {
    const answer = await context.ui.dialog.confirm({
      title: `Delete the Vercel project of ${choice.name} too?`,
      message:
        "The project is what runs the relay, so deleting it stops the relay. Choose no to forget the relay and leave the project running.",
      label: { confirm: "Delete it as well", cancel: "Leave it running" },
    })
    if (answer === undefined) return
    withProject = answer
  }
  const result = await callRpc(context, "Relay", () =>
    client.removeRelay({ id: choice.id, deleteProject: withProject }),
  )
  if (!result) return
  const message =
    project.length === 0
      ? `${choice.name} was removed. It had no Vercel project to delete.`
      : withProject
        ? result.projectDeleted
          ? `${choice.name} and its Vercel project were removed.`
          : `${choice.name} was removed, but its Vercel project could not be deleted. The status note says why.`
        : `${choice.name} was removed. Its Vercel project is still running.`
  const variant = withProject && !result.projectDeleted ? "warning" : "success"
  context.ui.toast.show({
    title: "Relay",
    message,
    variant,
    ...(variant === "warning" ? { duration: 9000 } : {}),
  })
  await refreshStatus(context, client)
}

/** Redeploy the current relay code over the relay that is already running. */
async function updateRelay(context: Context, client: RelayClient, id: string): Promise<void> {
  const updated = await withWorking(context, "Redeploying the relay", () =>
    callRpc(context, "Relay", () => client.updateRelay({ id })),
  )
  if (!updated) return
  context.ui.toast.show({
    title: "Relay",
    message: updated.reachable ? "The relay was redeployed and answers." : "The relay was redeployed but did not answer.",
    variant: updated.reachable ? "success" : "warning",
  })
  await refreshStatus(context, client)
}
