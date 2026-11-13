/**
 * The dialog flows of the relay plugin.
 *
 * The menu stays open: every action ends by asking what to do next, so a
 * change does not throw the user out of the plugin. A slow action says what it
 * is doing while it does it, and the lists offer the common next steps as key
 * bindings, so the mouse is not the only way through.
 *
 * Every flow is a short conversation with the user and ends in RPC calls and
 * one toast, so nothing ever happens silently. A rejection is caught here: an
 * unhandled rejection inside a plugin takes the whole TUI with it.
 */
import { createSignal, onCleanup } from "solid-js"
import type { Context, DialogSelectAction, DialogSelectOption } from "@opencode/plugin/tui/context"
import type { TextareaRenderable } from "@opentui/core"
import { Relay } from "../rpc.ts"
import { REGIONS, STRATEGIES, STRATEGY_LABELS, type Strategy } from "../lib/types.ts"
import {
  describeExit,
  exitList,
  menuOptions,
  statusLabel,
  type ExitChoice,
  type MenuAction,
} from "./present.ts"
import { currentStatus, publishStatus, type RelayModel, type RelayStatus } from "./state.ts"

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

/** Read the current routing state and publish it to the pill. */
export async function refreshStatus(context: Context, client: RelayClient): Promise<Refresh> {
  try {
    const status = await client.status({})
    publishStatus(status)
    return { ok: true, status }
  } catch (error) {
    return { ok: false, error }
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

/** A multi-line text box, for a pasted list or a configuration blob. */
function MultilineInput(props: {
  readonly title: string
  readonly description: string
  readonly hint: string
  readonly initial?: string
  readonly onSubmit: (text: string) => void
}) {
  let area: TextareaRenderable | undefined
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} gap={0}>
      <text>{props.title}</text>
      <text fg="#6c6c6c">{props.description}</text>
      <textarea
        ref={area}
        focused
        height={14}
        placeholder="paste here"
        initialValue={props.initial ?? ""}
        onSubmit={() => props.onSubmit(area?.plainText ?? "")}
      />
      <text fg="#6c6c6c">{props.hint}</text>
    </box>
  )
}

/**
 * Ask for a multi-line answer.
 *
 * The dialog's own prompt is one line, which is exactly wrong for a proxy
 * list: a list is pasted, not typed one line at a time. The textarea accepts
 * the paste whole, and alt+enter (or ctrl+enter on some terminals) confirms it.
 */
function askMultiline(
  context: Context,
  options: {
    readonly title: string
    readonly description: string
    readonly initial?: string
  },
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let finished = false
    const finish = (value: string | undefined): void => {
      if (finished) return
      finished = true
      resolve(value)
    }
    context.ui.dialog.show(
      () => (
        <MultilineInput
          title={options.title}
          description={options.description}
          hint="alt+enter to confirm - esc to cancel"
          {...(options.initial !== undefined ? { initial: options.initial } : {})}
          onSubmit={(text) => {
            finish(text)
            context.ui.dialog.clear()
          }}
        />
      ),
      () => finish(undefined),
    )
  })
}

/** Show text that the user may want to copy, in a dialog they can scroll. */
function showText(context: Context, title: string, text: string): Promise<void> {
  return new Promise((resolve) => {
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      resolve()
    }
    context.ui.dialog.show(
      () => (
        <box flexDirection="column" paddingLeft={1} paddingRight={1}>
          <text>{title}</text>
          <textarea focused height={18} initialValue={text} />
          <text fg="#6c6c6c">select with the mouse to copy - esc to close</text>
        </box>
      ),
      finish,
    )
  })
}

/**
 * The menu, and it stays open.
 *
 * Every action ends by asking what to do next, so a change does not throw the
 * user out of the plugin and back to the prompt. `t` tests every exit and `r`
 * brings the used-up exits back, without leaving the menu.
 */
let menuOpen = false

export async function openRelayMenu(context: Context, client: RelayClient): Promise<void> {
  // A second click on the pill, or a second /relay while the menu is up, must
  // not stack menus on top of each other.
  if (menuOpen) return
  menuOpen = true
  try {
    for (;;) {
      const refreshed = await refreshStatus(context, client)
      const status = refreshed.ok ? refreshed.status : currentStatus()
      if (!status) {
        if (!refreshed.ok) reportError(context, "Relay", refreshed.error)
        return
      }
      if (!refreshed.ok) {
        // A refresh that failed is worth saying once, but it must not throw the
        // user out of the menu. The last known state is still useful, and the
        // next action may well succeed.
        reportError(context, "Relay", refreshed.error)
      }
      const actions: DialogSelectAction<MenuAction>[] = []
      if (status.exits.length > 0) {
        actions.push({
          bind: "t",
          title: "test all",
          side: "left",
          selection: "none",
          onTrigger: () => {
            void startTestAll(context, client, false)
          },
        })
      }
      if (status.exhausted.length > 0) {
        actions.push({
          bind: "r",
          title: "bring back",
          side: "left",
          selection: "none",
          onTrigger: () => {
            void restoreExhausted(context, client)
          },
        })
      }
      const choice = await context.ui.dialog.select<MenuAction>({
        title: "Relay",
        options: menuOptions(status),
        ...(actions.length > 0 ? { actions } : {}),
      })
      if (choice === undefined || choice === "close") return
      await runAction(context, client, status, choice)
    }
  } finally {
    menuOpen = false
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
    case "direct":
      return chooseDirect(context, client, status)
    case "preview":
      return showPreview(context, client, status)
    case "exits":
      return manageExits(context, client)
    case "deploy":
      return deployRelay(context, client, status)
    case "track-relay":
      return trackRelay(context, client)
    case "add-proxies":
      return addProxies(context, client)
    case "test-all":
      return startTestAll(context, client, false)
    case "update-all":
      return updateAllRelays(context, client)
    case "restore":
      return restoreExhausted(context, client)
    case "health":
      return toggleHealthChecks(context, client, status)
    case "transfer":
      return transferConfig(context, client)
    case "add-account":
      return addAccount(context, client)
    case "remove-account":
      return removeAccount(context, client, status)
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
    ...(enabled && note ? { duration: 8000 } : {}),
  })
}

/** Choose how the exits are used. */
async function chooseStrategy(context: Context, client: RelayClient, status: RelayStatus): Promise<void> {
  const options = STRATEGIES.map(
    (strategy): DialogSelectOption<Strategy> => ({
      title: STRATEGY_LABELS[strategy].title,
      value: strategy,
      description: STRATEGY_LABELS[strategy].description,
    }),
  )
  const choice = await context.ui.dialog.select<Strategy>({
    title: "How should the exits be used?",
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

/** Choose what happens when no exit can serve a request. */
async function chooseDirect(context: Context, client: RelayClient, status: RelayStatus): Promise<void> {
  const choice = await context.ui.dialog.select<"allow" | "never">({
    title: "When no exit can serve",
    options: [
      {
        title: "Go direct",
        value: "allow",
        description: "Keep working without an exit. OpenCode sees this machine's address.",
      },
      {
        title: "Never go direct",
        value: "never",
        description: "Fail the request instead. Nothing leaves without an exit.",
      },
    ],
    current: status.direct,
  })
  if (choice === undefined) return
  const result = await callRpc(context, "Relay", () => client.setDirect({ direct: choice }))
  if (!result) return
  context.ui.toast.show({
    title: "Relay",
    message:
      choice === "never"
        ? "Direct routing is off: a request with no usable exit now fails."
        : "Direct routing is allowed: requests fall back to OpenCode when no exit can serve.",
    variant: choice === "never" ? "warning" : "success",
  })
  await refreshStatus(context, client)
}

/** Show where the next request would go, without sending anything. */
async function showPreview(context: Context, client: RelayClient, status: RelayStatus): Promise<void> {
  // The model the prompt is pointed at, so the preview is about the request
  // the user is about to make. A model of another provider previews as "only
  // the opencode provider is routed", which is the truth and not a claim that
  // this model would go through an exit.
  const current = context.ui.model.current()
  const result = await callRpc(context, "Relay", () =>
    client.preview({
      ...(current ? { modelId: current.modelID, providerID: current.providerID } : {}),
    }),
  )
  if (!result) return
  const lines = [result.reason]
  if (status.lastDecision) {
    lines.push("", `Last request: ${status.lastDecision.modelId} - ${status.lastDecision.reason}`)
  }
  if (result.skipped.length > 0) {
    lines.push("", "Left out:")
    for (const exit of result.skipped) lines.push(`  ${exit.name}: ${exit.reason}`)
  }
  if (!result.routed) {
    lines.push(
      "",
      result.direct === "never"
        ? "Direct routing is off, so this request would fail."
        : "The request would go straight to OpenCode.",
    )
  }
  await context.ui.dialog.alert({ title: "The next request", message: lines.join("\n") })
}

/** Bring the exits whose allowance is gone back into use. */
async function restoreExhausted(context: Context, client: RelayClient): Promise<void> {
  const result = await callRpc(context, "Relay", () => client.resetExhausted({}))
  if (!result) return
  context.ui.toast.show({
    title: "Relay",
    message:
      result.restored.length === 0
        ? "No exit was out of use."
        : `${result.restored.length} exit${result.restored.length === 1 ? " is" : "s are"} back in use.`,
    variant: "success",
  })
  await refreshStatus(context, client)
}

/** Turn the background health checks on or off. */
async function toggleHealthChecks(
  context: Context,
  client: RelayClient,
  status: RelayStatus,
): Promise<void> {
  const enabled = !status.healthChecks
  const result = await callRpc(context, "Relay", () => client.setHealthChecks({ enabled }))
  if (!result) return
  context.ui.toast.show({
    title: "Relay",
    message: enabled
      ? "Background checks are on: exits are checked every 10 minutes."
      : "Background checks are off. Exits are only checked when you ask.",
    variant: "success",
  })
  await refreshStatus(context, client)
}

/** Let the user say which models go through the exits. Only free models are ever routed. */
async function chooseModels(context: Context, client: RelayClient, status: RelayStatus): Promise<void> {
  const result = await callRpc(context, "Relay", () => client.models({}))
  if (!result) return
  const models = result.models
  const free = models.filter((model) => model.free)
  if (free.length === 0) {
    await context.ui.dialog.alert({
      title: "No free models",
      message:
        models.length === 0
          ? "The model list of the OpenCode provider could not be read. The plugin cannot tell which models are free, so nothing is routed."
          : "The OpenCode provider lists no free model right now. The plugin only routes free models.",
    })
    return
  }
  const mode = await context.ui.dialog.select<"free" | "custom">({
    title: `Route models (${free.length} free)`,
    options: [
      {
        title: "Route every free model",
        value: "free",
        description: `Every free model of the opencode provider${models.length > free.length ? `; ${models.length - free.length} paid models are never routed` : ""}`,
      },
      {
        title: "Choose free models one by one",
        value: "custom",
        description: "Pick exactly which free models are routed",
      },
    ],
    current: status.selection,
  })
  if (mode === undefined) return
  if (mode === "free") {
    await setSelection(context, client, { selection: "free" })
    return
  }
  await pickModels(context, client, free, status.customModels)
}

/** Ask about one free model at a time until the user says they are done. */
async function pickModels(
  context: Context,
  client: RelayClient,
  models: readonly RelayModel[],
  initial: readonly string[],
): Promise<void> {
  const picked = new Set(initial.filter((id) => models.some((model) => model.id === id)))
  const baseline = [...picked]
  const unchanged = () =>
    picked.size === baseline.length && baseline.every((id) => picked.has(id))
  let current: { readonly kind: "model"; readonly id: string } | undefined
  for (;;) {
    const options: DialogSelectOption<
      { readonly kind: "model"; readonly id: string } | { readonly kind: "done" }
    >[] = models.map((model) => ({
      title: model.name,
      value: { kind: "model", id: model.id },
      description: `opencode/${model.id} - free - ${picked.has(model.id) ? "routed" : "not routed"}`,
    }))
    options.push({ title: "Done", value: { kind: "done" }, description: "Save this selection" })
    const choice = await context.ui.dialog.select({
      title: `Choose free models to route (${picked.size} picked)`,
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
      message: `${model.id} - runs on the free allowance.`,
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
  input: { readonly selection: "free" | "custom"; readonly models?: readonly string[] },
): Promise<void> {
  const result = await callRpc(context, "Relay", () => client.setSelection(input))
  if (!result) return
  const count = result.customModels.length
  const dropped = result.dropped.length
  const message =
    result.selection === "free"
      ? `The free models are routed${dropped > 0 ? `; ${dropped} paid model${dropped === 1 ? " was" : "s were"} left out` : ""}.`
      : count === 0
        ? "No model is routed. Choose at least one."
        : `${count} free model${count === 1 ? " is" : "s are"} routed.`
  context.ui.toast.show({
    title: "Relay",
    message,
    variant: result.selection === "custom" && count === 0 ? "warning" : "success",
  })
  await refreshStatus(context, client)
}

/** A test result, in one line. */
function describeTest(
  result: {
    readonly ok: boolean
    readonly status: string
    readonly code: number
    readonly ms: number
    readonly egress?: string
    readonly note?: string
  },
  name: string,
): string {
  if (result.ok) {
    const kind = result.status === "reachable" ? "Reachable" : "Ready"
    return `${name}: ${kind} in ${result.ms} ms${result.egress ? ` - leaves from ${result.egress}` : ""}.`
  }
  const code = result.code > 0 ? ` (HTTP ${result.code})` : ""
  return `${name}: ${statusLabel(result.status)}${code}. ${result.note ?? ""}`.trim()
}

/**
 * Report whether an exit answers, in a toast that leaves the list open.
 *
 * A test is a look, not a move: it must not throw the user out of the list
 * they are choosing from, so it never opens a dialog of its own.
 */
async function quickTest(context: Context, client: RelayClient, exit: ExitChoice): Promise<void> {
  context.ui.toast.show({ title: "Relay", message: `Testing ${exit.name}...`, variant: "info" })
  const result = await callRpc(context, "Relay", () => client.testExit({ id: exit.id }))
  if (!result) return
  context.ui.toast.show({
    title: "Relay",
    message: describeTest(result, exit.name),
    variant: result.ok ? "success" : "warning",
    duration: result.ok ? 4000 : 8000,
  })
  void refreshStatus(context, client)
}

/** The key binding that tests the exit the cursor is on. */
function testAction(context: Context, client: RelayClient): DialogSelectAction<ExitListChoice> {
  return {
    bind: "t",
    title: "test",
    side: "left",
    selection: "required",
    onTrigger: (value) => {
      if (value.kind === "add") return
      void quickTest(context, client, value)
    },
  }
}

/** An exit, or the entry that adds more. */
type ExitListChoice = ExitChoice | { readonly kind: "add" }

/** The relays and proxies, and what can be done with each. */
async function manageExits(context: Context, client: RelayClient): Promise<void> {
  for (;;) {
    const refreshed = await refreshStatus(context, client)
    const status = refreshed.ok ? refreshed.status : currentStatus()
    if (!status) return
    if (!refreshed.ok) reportError(context, "Relay", refreshed.error)
    if (status.exits.length === 0) {
      const add = await context.ui.dialog.confirm({
        title: "No relay or proxy yet",
        message: "Add a list of proxies now, or deploy a relay from the menu.",
        label: { confirm: "Add proxies", cancel: "Close" },
      })
      if (add) await addProxies(context, client)
      return
    }
    const active = status.activeExit
    const current: ExitListChoice | undefined =
      active === undefined
        ? undefined
        : { id: active.id, name: active.name, kind: active.kind }
    const options: DialogSelectOption<ExitListChoice>[] = [
      ...exitList(status),
      { title: "Add proxies", value: { kind: "add" }, description: "Paste a list of HTTP, HTTPS or SOCKS proxies" },
    ]
    const choice = await context.ui.dialog.select<ExitListChoice>({
      title: "Relays and proxies",
      options,
      ...(current !== undefined ? { current } : {}),
      actions: [testAction(context, client)],
    })
    if (choice === undefined) return
    if (choice.kind === "add") {
      await addProxies(context, client)
      continue
    }
    await exitDetail(context, client, choice.id)
  }
}

/** Everything that can be done with one exit. */
type DetailAction = "use" | "test" | "deep" | "toggle" | "edit" | "remove" | "back"

async function exitDetail(context: Context, client: RelayClient, id: string): Promise<void> {
  for (;;) {
    const refreshed = await refreshStatus(context, client)
    const status = refreshed.ok ? refreshed.status : currentStatus()
    if (!status) return
    const exit = status.exits.find((item) => item.id === id)
    if (!exit) {
      context.ui.toast.show({ title: "Relay", message: "That exit is not there any more.", variant: "warning" })
      return
    }
    const exhausted = status.exhausted.includes(id)
    const chosen = status.activeExit?.id === id
    const options: DialogSelectOption<DetailAction>[] = [
      {
        title: exhausted ? "Use it anyway" : "Use this exit",
        value: "use",
        description: chosen
          ? "Already the chosen exit"
          : "Prefer it in the one-exit and until-exhausted strategies",
        ...(chosen ? { disabled: true } : {}),
      },
      {
        title: "Test through OpenCode",
        value: "test",
        description: "Asks OpenCode for its model list through this exit",
      },
      {
        title: "Deep test with a real model",
        value: "deep",
        description: "Sends one tiny free-model request; the only check that proves the allowance",
      },
      {
        title: exit.enabled ? "Pause this exit" : "Resume this exit",
        value: "toggle",
        description: exit.enabled
          ? "Keep it, but stop using it"
          : "Use it again in routing and checks",
      },
      ...(exit.kind === "proxy"
        ? [{ title: "Edit its name or address", value: "edit" as const, description: "A new address is tested afresh" }]
        : []),
      { title: "Remove this exit", value: "remove", description: "Vercel projects are asked about separately" },
      { title: "Back", value: "back" },
    ]
    const choice = await context.ui.dialog.select<DetailAction>({
      title: `${exit.name} - ${statusLabel(exit.status)}`,
      options,
      ...(exit.lastError !== undefined ? { placeholder: exit.lastError } : {}),
    })
    if (choice === undefined || choice === "back") return

    switch (choice) {
      case "use": {
        const result = await callRpc(context, "Relay", () => client.useExit({ id }))
        if (!result) break
        context.ui.toast.show({
          title: "Relay",
          message: exhausted
            ? `${exit.name} is chosen, but it stays out of use until its allowance resets.`
            : `${exit.name} is the chosen exit.`,
          variant: exhausted ? "warning" : "success",
        })
        break
      }
      case "test": {
        const result = await withWorking(context, `Testing ${exit.name}`, () =>
          callRpc(context, "Relay", () => client.testExit({ id })),
        )
        if (!result) break
        context.ui.toast.show({
          title: "Relay",
          message: describeTest(result, exit.name),
          variant: result.ok ? "success" : "warning",
          duration: result.ok ? 5000 : 9000,
        })
        break
      }
      case "deep": {
        const result = await withWorking(context, `Sending a real request through ${exit.name}`, () =>
          callRpc(context, "Relay", () => client.testExit({ id, deep: true })),
        )
        if (!result) break
        context.ui.toast.show({
          title: "Relay",
          message: describeTest(result, exit.name),
          variant: result.ok ? "success" : "warning",
          duration: result.ok ? 6000 : 10000,
        })
        break
      }
      case "toggle": {
        const result = await callRpc(context, "Relay", () =>
          client.setExitEnabled({ id, enabled: !exit.enabled }),
        )
        if (!result) break
        context.ui.toast.show({
          title: "Relay",
          message: exit.enabled ? `${exit.name} is paused.` : `${exit.name} is back in use.`,
          variant: "success",
        })
        break
      }
      case "edit": {
        await editProxy(context, client, id, exit.name, exit.url)
        break
      }
      case "remove": {
        await removeExit(context, client, exit)
        return
      }
    }
  }
}

/** Change a proxy's name or address. */
async function editProxy(
  context: Context,
  client: RelayClient,
  id: string,
  name: string,
  url: string,
): Promise<void> {
  const nextName = await context.ui.dialog.prompt({
    title: "Name this proxy",
    description: "A name you will recognize later.",
    placeholder: name,
    value: name,
  })
  if (nextName === undefined) return
  if (nextName.trim().length > 0 && nextName.trim() !== name) {
    const changed = await callRpc(context, "Relay", () =>
      client.updateProxy({ id, name: nextName.trim() }),
    )
    if (!changed?.updated) {
      context.ui.toast.show({ title: "Relay", message: "The name was not changed.", variant: "warning" })
    }
  }
  const nextUrl = await context.ui.dialog.prompt({
    title: "Proxy address",
    description: "user:pass@host:port, or a full http://, https://, socks4:// or socks5:// URL.",
    placeholder: url,
    value: url,
  })
  if (nextUrl === undefined) return
  if (nextUrl.trim().length === 0 || nextUrl.trim() === url) return
  const changed = await withWorking(context, "Testing the new address", () =>
    callRpc(context, "Relay", () => client.updateProxy({ id, url: nextUrl.trim() })),
  )
  if (!changed?.updated) {
    context.ui.toast.show({
      title: "Relay",
      message: "That address could not be read as a proxy. It was left as it was.",
      variant: "error",
    })
    return
  }
  context.ui.toast.show({
    title: "Relay",
    message: "The address was changed and is being checked.",
    variant: "success",
  })
}

/** Remove an exit, asking about a Vercel project when there is one. */
async function removeExit(
  context: Context,
  client: RelayClient,
  exit: RelayStatus["exits"][number],
): Promise<void> {
  const sure = await context.ui.dialog.confirm({
    title: `Remove ${exit.name}?`,
    message:
      exit.kind === "relay"
        ? "The relay stays deployed on Vercel; only this plugin forgets it. You can ask to delete the project too."
        : "The proxy is only removed from this plugin.",
    label: { confirm: "Remove it", cancel: "Keep it" },
  })
  if (!sure) return

  if (exit.kind === "relay" && (exit.project ?? "").length > 0) {
    const deleteProject = await context.ui.dialog.confirm({
      title: `Delete the Vercel project of ${exit.name} too?`,
      message:
        "The project is what runs the relay, so deleting it stops the relay. Choose no to forget the relay and leave the project running.",
      label: { confirm: "Delete it as well", cancel: "Leave it running" },
    })
    if (deleteProject === undefined) return
    const result = await withWorking(context, "Removing the relay", () =>
      callRpc(context, "Relay", () => client.removeRelay({ id: exit.id, deleteProject })),
    )
    if (!result) return
    const message = !deleteProject
      ? `${exit.name} was removed. Its Vercel project is still running.`
      : result.projectDeleted
        ? `${exit.name} and its Vercel project were removed.`
        : `${exit.name} was removed, but its Vercel project could not be deleted. The status note says why.`
    context.ui.toast.show({
      title: "Relay",
      message,
      variant: deleteProject && !result.projectDeleted ? "warning" : "success",
      ...(deleteProject && !result.projectDeleted ? { duration: 9000 } : {}),
    })
  } else {
    const result = await callRpc(context, "Relay", () => client.removeExit({ id: exit.id }))
    if (!result) return
    context.ui.toast.show({
      title: "Relay",
      message: result.removed ? `${exit.name} was removed.` : `${exit.name} was not found.`,
      variant: result.removed ? "success" : "warning",
    })
  }
  await refreshStatus(context, client)
}

/** Paste a proxy list and add everything that can be read from it. */
async function addProxies(context: Context, client: RelayClient): Promise<void> {
  const text = await askMultiline(context, {
    title: "Paste your proxy list",
    description:
      "One proxy per line, or several per line. http://host:port, https://user:pass@host:port, socks5://host:port, host:port, host:port:user:pass and user:pass@host:port all work.",
  })
  if (text === undefined) return
  if (text.trim().length === 0) {
    context.ui.toast.show({ title: "Relay", message: "The list was empty.", variant: "warning" })
    return
  }
  const result = await withWorking(context, "Reading the list", () =>
    callRpc(context, "Relay", () => client.addProxies({ text })),
  )
  if (!result) return
  const added = result.added.length
  const parts = [`${added} prox${added === 1 ? "y" : "ies"} added`]
  if (result.duplicates > 0) parts.push(`${result.duplicates} already there`)
  if (result.invalid.length > 0) parts.push(`${result.invalid.length} could not be read`)
  context.ui.toast.show({
    title: "Relay",
    message: parts.join(" - "),
    variant: added > 0 ? "success" : "warning",
    duration: 6000,
  })
  if (result.invalid.length > 0) {
    const lines = result.invalid
      .slice(0, 6)
      .map((entry) => `${entry.value.length > 0 ? entry.value : "(empty)"}: ${entry.reason}`)
    if (result.invalid.length > 6) lines.push(`...and ${result.invalid.length - 6} more`)
    await context.ui.dialog.alert({
      title: "Some entries were left out",
      message: `The list had ${result.invalid.length} entr${result.invalid.length === 1 ? "y" : "ies"} that could not be read:\n\n${lines.join("\n")}`,
    })
  }
  if (added > 0) {
    context.ui.toast.show({
      title: "Relay",
      message: "The new proxies are being checked in the background.",
      variant: "info",
    })
  }
  await refreshStatus(context, client)
}

/** Start checking every exit without blocking the menu. */
async function startTestAll(context: Context, client: RelayClient, deep: boolean): Promise<void> {
  const result = await callRpc(context, "Relay", () => client.testAll({ deep }))
  if (!result) return
  context.ui.toast.show({
    title: "Relay",
    message:
      result.total === 0
        ? "There is no exit to check."
        : result.started
          ? `Checking ${result.total} exit${result.total === 1 ? "" : "s"}${deep ? " with a real model request" : ""} in the background.`
          : "A check is already running.",
    variant: result.started ? "success" : "info",
  })
  await refreshStatus(context, client)
}

/** Redeploy every relay with the current code. */
async function updateAllRelays(context: Context, client: RelayClient): Promise<void> {
  const sure = await context.ui.dialog.confirm({
    title: "Update every relay?",
    message: "Each relay this plugin deployed is redeployed with the current code. The addresses and tokens stay the same.",
    label: { confirm: "Update them", cancel: "Not now" },
  })
  if (!sure) return
  const result = await withWorking(context, "Redeploying the relays", () =>
    callRpc(context, "Relay", () => client.updateAllRelays({})),
  )
  if (!result) return
  if (result.failed.length === 0) {
    context.ui.toast.show({
      title: "Relay",
      message: `${result.updated} relay${result.updated === 1 ? "" : "s"} updated.`,
      variant: "success",
    })
    return
  }
  await context.ui.dialog.alert({
    title: "Some relays were not updated",
    message: [
      `${result.updated} updated, ${result.failed.length} failed.`,
      "",
      ...result.failed.map((entry) => `${entry.name}: ${entry.message}`),
    ].join("\n"),
  })
}

/** Move exits and rules between machines. */
async function transferConfig(context: Context, client: RelayClient): Promise<void> {
  const mode = await context.ui.dialog.select<"export" | "import">({
    title: "Export or import",
    options: [
      {
        title: "Export",
        value: "export",
        description: "Write the exits and rules out as JSON, credentials included",
      },
      {
        title: "Import",
        value: "import",
        description: "Read exits and rules back in; Vercel accounts are never imported",
      },
    ],
  })
  if (mode === undefined) return

  if (mode === "export") {
    const result = await withWorking(context, "Writing the configuration", () =>
      callRpc(context, "Relay", () => client.exportConfig({})),
    )
    if (!result) return
    await showText(context, "Configuration", result.json)
    return
  }

  const json = await askMultiline(context, {
    title: "Paste the configuration",
    description: "The JSON that Export produced. It is read once and never stored as a file.",
  })
  if (json === undefined || json.trim().length === 0) return
  const result = await withWorking(context, "Reading the configuration", () =>
    callRpc(context, "Relay", () => client.importConfig({ json })),
  )
  if (!result) return
  const parts = [`${result.relays} relay${result.relays === 1 ? "" : "s"} and ${result.proxies} prox${result.proxies === 1 ? "y" : "ies"} imported`]
  if (result.invalid > 0) parts.push(`${result.invalid} entr${result.invalid === 1 ? "y" : "ies"} left out`)
  context.ui.toast.show({
    title: "Relay",
    message: parts.join(" - "),
    variant: result.invalid > 0 ? "warning" : "success",
    duration: 6000,
  })
  await refreshStatus(context, client)
}

/** Deploy a new relay to one region, or several at once. */
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
  const regions = await pickRegions(context)
  if (regions.length === 0) return
  const name = await context.ui.dialog.prompt({
    title: "Name the relay",
    description: "It is only a label here; every region gets the same name and its own address.",
    placeholder: regions.length === 1 ? `Relay in ${regions[0]}` : "my relay",
  })
  const label =
    name !== undefined && name.trim().length > 0 ? name.trim() : regions.length === 1 ? undefined : "my relay"

  if (regions.length === 1) {
    const region = regions[0]!
    const deployed = await withWorking(context, `Deploying a relay in ${region}`, () =>
      callRpc(context, "Relay", () =>
        client.deployRelay({
          accountId: account.id,
          region,
          ...(label !== undefined ? { name: label } : {}),
        }),
      ),
    )
    if (!deployed) return
    context.ui.toast.show({
      title: "Relay",
      message: `${deployed.name} is deployed in ${deployed.regionLabel}: ${deployed.url}`,
      variant: "success",
      duration: 8000,
    })
    await refreshStatus(context, client)
    return
  }

  const deployed = await withWorking(context, `Deploying ${regions.length} relays`, () =>
    callRpc(context, "Relay", () =>
      client.deployRelays({
        accountId: account.id,
        regions,
        ...(label !== undefined ? { name: label } : {}),
      }),
    ),
  )
  if (!deployed) return
  if (deployed.failed.length === 0) {
    context.ui.toast.show({
      title: "Relay",
      message: `${deployed.deployed.length} relays deployed.`,
      variant: "success",
      duration: 8000,
    })
  } else {
    await context.ui.dialog.alert({
      title: "Some regions failed",
      message: [
        `${deployed.deployed.length} deployed, ${deployed.failed.length} failed.`,
        "",
        ...deployed.failed.map((entry) => `${entry.region}: ${entry.message}`),
      ].join("\n"),
    })
  }
  await refreshStatus(context, client)
}

/** Pick one region, or several at once. */
async function pickRegions(context: Context): Promise<readonly string[]> {
  const picked = new Set<string>()
  let current: { readonly kind: "region"; readonly code: string } | { readonly kind: "done" } | undefined
  for (;;) {
    const options: DialogSelectOption<
      { readonly kind: "region"; readonly code: string } | { readonly kind: "done" }
    >[] = REGIONS.map((region) => ({
      title: region.label,
      value: { kind: "region", code: region.code },
      description: `${region.code} - ${picked.has(region.code) ? "chosen" : "not chosen"}`,
    }))
    options.push({
      title: picked.size === 0 ? "Deploy" : `Deploy to ${picked.size} region${picked.size === 1 ? "" : "s"}`,
      value: { kind: "done" },
      description: picked.size === 0 ? "Pick at least one region first" : [...picked].join(", "),
      ...(picked.size === 0 ? { disabled: true } : {}),
    })
    const choice = await context.ui.dialog.select({
      title: "Deploy to which regions?",
      options,
      current,
    })
    if (choice === undefined) return []
    if (choice.kind === "done") return [...picked]
    current = choice
    if (picked.has(choice.code)) picked.delete(choice.code)
    else picked.add(choice.code)
  }
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
