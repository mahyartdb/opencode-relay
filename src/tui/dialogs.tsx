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
import type {
  Context,
  DialogAlertOptions,
  DialogConfirmOptions,
  DialogOptions,
  DialogPromptOptions,
  DialogSelectAction,
  DialogSelectOption,
  DialogSelectOptions,
  DialogSize,
  ToastOptions,
} from "@opencode/plugin/tui/context"
import type { TextareaRenderable } from "@opentui/core"
import { Relay } from "../rpc.ts"
import { REGIONS, STRATEGIES, STRATEGY_LABELS, regionLabel, type Strategy } from "../lib/types.ts"
import {
  describeExitDetails,
  describePreview,
  describeSelection,
  describeSettings,
  describeStatusPage,
  describeStrategy,
  exitsMenuOptions,
  isDeployedExit,
  isUsableExit,
  menuOptions,
  statusLabel,
  toggleModel,
  type ExitChoice,
  type ExitListAction,
  type MenuAction,
} from "./present.ts"
import { currentStatus, isReachable, markReachable, publishStatus, clearState, type RelayModel, type RelayStatus } from "./state.ts"

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
 * The refresh in flight, and whether another one was asked for meanwhile.
 *
 * Every status change announces itself, and a scan announces once per exit,
 * so the refreshes arrive in bursts. Letting them all run would let a slow
 * answer land after a fast one and put the pill back to an older state, so
 * only one runs at a time and a request made during one queues exactly one
 * more - the one that sees the newest state.
 *
 * A caller that arrives during a refresh waits for that queued run, not for
 * the one already on its way: it asked for the newest state, and the answer
 * it would get from the running one is older than what it asked for.
 */
let refreshInFlight: Promise<Refresh> | undefined
let refreshQueued = false
let refreshPending: { readonly promise: Promise<Refresh>; readonly resolve: (result: Refresh) => void } | undefined
/** Whether a caller wants to hear that the server is not answering. */
let refreshLoud = false

/**
 * Bumped when the plugin is deactivated.
 *
 * An answer that arrives after that must not repaint the footer of the
 * plugin that replaced it, and a new activation must not join the promise of
 * the old one.
 */
let refreshGeneration = 0

/** Release the refresh latch, so a re-activated plugin starts fresh. */
export function resetRefresh(): void {
  refreshGeneration += 1
  refreshInFlight = undefined
  refreshQueued = false
  // A loud caller from the last activation must not make the new one's
  // startup probe paint a starting server as dead.
  refreshLoud = false
  // The callers that were waiting are let go: a promise that never settles
  // would leave a menu loop suspended across the reload.
  const pending = refreshPending
  refreshPending = undefined
  pending?.resolve({ ok: false, error: new Error("The relay plugin was reloaded.") })
  // The "reported once" memory does not outlive the activation either: the
  // reloaded plugin has never reported anything, and staying silent about a
  // dead server would be the one thing the pill exists to prevent.
  reportedRefreshErrors.clear()
}

/**
 * How long a status call may take before the server counts as not answering.
 *
 * The server reads the provider's model list on every status call, and that
 * fetch can hang behind a blocked network. Without a deadline the pill would
 * keep painting the last snapshot as healthy while nothing could be known,
 * and the single-flight queue would swallow every heartbeat until the hung
 * call returned.
 */
const STATUS_TIMEOUT_MS = 12_000

/**
 * How long a slow thing may take before the dialog says so.
 *
 * The dialog that names the work appears only after this: most calls answer
 * in a moment, and a dialog that flashes for one frame is noise.
 */
const WORKING_DELAY_MS = 250

/**
 * Give up on a call that does not answer.
 *
 * The answer that arrives after the deadline is ignored: it is too late to
 * be the state the caller asked for. The call itself is cancelled, so a
 * wedged server does not collect a pile of abandoned requests.
 */
function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController()
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`The relay plugin's server half did not answer within ${ms / 1000} seconds.`))
    }, ms)
    // A work that throws before it returns a promise must not leave the timer
    // armed: the call is already decided, and the timer would keep the
    // process alive for no reason.
    let started: Promise<T>
    try {
      started = work(controller.signal)
    } catch (error) {
      clearTimeout(timer)
      reject(error)
      return
    }
    started.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** Read the current routing state and publish it to the pill. */
export async function refreshStatus(
  context: Context,
  client: RelayClient,
  options: { readonly quiet?: boolean } = {},
): Promise<Refresh> {
  if (refreshInFlight !== undefined) {
    refreshQueued = true
    // A caller that asked to stay quiet must not have its run say the server
    // is dead: the queued run is quiet unless someone wants it loud.
    if (!options.quiet) refreshLoud = true
    if (refreshPending === undefined) {
      let resolve!: (result: Refresh) => void
      const promise = new Promise<Refresh>((settle) => {
        resolve = settle
      })
      refreshPending = { promise, resolve }
    }
    return refreshPending.promise
  }
  const generation = refreshGeneration
  const quiet = options.quiet === true && !refreshLoud
  const run = (async (): Promise<Refresh> => {
    try {
      const status = await withDeadline(
        // The signal is the second argument, the request options: passing it
        // as input would quietly build an empty request, and the deadline
        // would reject the caller without ever cancelling the call.
        (signal) => client.status({}, { signal }),
        STATUS_TIMEOUT_MS,
      )
      // An answer that arrives after the plugin was deactivated must not
      // repaint the footer of the plugin that replaced it.
      if (generation === refreshGeneration) {
        publishStatus(status)
        markReachable(true)
      }
      return { ok: true, status }
    } catch (error) {
      // The server did not answer. The pill must say so rather than keep
      // painting a healthy state that stopped being true. A quiet attempt is
      // one the caller expects to fail - a server that is still starting is
      // not a server that is dead.
      if (!quiet && generation === refreshGeneration) markReachable(false)
      return { ok: false, error }
    }
  })()
  refreshInFlight = run
  try {
    return await run
  } finally {
    if (generation === refreshGeneration) {
      refreshInFlight = undefined
      if (refreshQueued) {
        refreshQueued = false
        const pending = refreshPending
        refreshPending = undefined
        const loud = refreshLoud
        refreshLoud = false
        void refreshStatus(context, client, { quiet: !loud }).then((result) =>
          pending?.resolve(result),
        )
      }
    }
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
 *
 * Esc closes the dialog but not the work: a deployment that is already under
 * way goes on by itself. The work then finishes into a toast, so the user is
 * told the outcome either way.
 *
 * The dialog waits a moment before it appears: most of these calls answer
 * immediately, and a dialog that flashes for one frame is worse than no
 * dialog at all.
 */
async function withWorking<T>(context: Context, message: string, run: () => Promise<T>): Promise<T> {
  let closed = false
  let shown = false
  const timer = setTimeout(() => {
    shown = true
    context.ui.dialog.show(
      () => <Working message={message} />,
      () => {
        closed = true
      },
    )
  }, WORKING_DELAY_MS)
  try {
    return await run()
  } finally {
    clearTimeout(timer)
    // The dialog may already be gone: the user closed it, or another dialog
    // took its place, and closing that one by mistake would be worse.
    if (shown && !closed) context.ui.dialog.clear()
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
  // The plugin may have been reloaded: the dialog would never open, and a
  // flow that waits for an answer that cannot come never ends.
  if (activationGone(context)) return Promise.resolve(undefined)
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
function showText(
  context: Context,
  title: string,
  text: string,
  size: DialogSize = "medium",
): Promise<void> {
  // The plugin may have been reloaded: the dialog would never open, and the
  // flow would wait for a close that cannot come.
  if (activationGone(context)) return Promise.resolve()
  return new Promise((resolve) => {
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      resolve()
    }
    // The box is as tall as what it holds, from three rows to eighteen; a
    // longer page scrolls instead of growing over the prompt behind it.
    const lines = text.split("\n").length + 1
    const height = Math.min(18, Math.max(3, lines))
    context.ui.dialog.show(
      () => (
        <box flexDirection="column" paddingLeft={1} paddingRight={1}>
          <text>{title}</text>
          <scrollbox
            width="100%"
            height={height}
            maxHeight={18}
            scrollY
            focused
            paddingLeft={1}
            paddingRight={1}
          >
            <text width="100%" wrapMode="word" selectable>
              {text}
            </text>
            <text fg="#6c6c6c">select with the mouse to copy - esc to close</text>
          </scrollbox>
        </box>
      ),
      finish,
    )
    // A page of text is wider than a question, so the dialog is asked for the
    // room after it exists, while it is still the active one.
    context.ui.dialog.set({ size })
  })
}

/**
 * Reports refresh failures, but only once per sentence.
 *
 * The heartbeat, the events and the menu all notice the same dead server,
 * so they share one memory: the same failure is reported once, whoever saw
 * it first. A loop that cannot refresh falls back to the last known state,
 * which is still useful; toasting the same error on every pass would bury
 * the next, different one. Success clears the memory, so a returning
 * problem is reported again.
 */
const reportedRefreshErrors = new Set<string>()

/** Report a refresh's failure, or clear the memory on success. */
export function refreshErrorToaster(context: Context): (refresh: Refresh) => void {
  return (refresh) => {
    if (refresh.ok) {
      reportedRefreshErrors.clear()
      return
    }
    const text = describeError(refresh.error)
    if (reportedRefreshErrors.has(text)) return
    reportedRefreshErrors.add(text)
    reportError(context, "Relay", refresh.error)
  }
}

/**
 * The menu, and it stays open.
 *
 * The main menu is only hubs: every action ends by asking what to do next,
 * and the submenus loop on themselves, so a change never throws the user out
 * to the prompt. Esc on a submenu returns to the main menu; Esc here leaves.
 *
 * The guard is a module global because the entry point and the menu share a
 * module, but it is cleared by the plugin's cleanup: a plugin that is
 * deactivated while its menu is open would otherwise leave the flag set, and
 * every later /relay would answer "the menu is already open" forever.
 */
let menuOwner: number | undefined

/** Release the menu guard, so a re-activated plugin is not locked out. */
export function releaseRelayMenu(token: number): void {
  if (menuOwner === token) menuOwner = undefined
}

/**
 * The activation the plugin is currently in.
 *
 * The plugin can be reloaded while its menu is open. The old menu keeps
 * running: its calls still answer, and it would toast into the terminal of
 * the plugin that replaced it, replace the dialog that one has open, and
 * clear it when it finishes. Every screen operation the old menu makes goes
 * through a context that asks whether the activation is still the one on
 * screen.
 */
let activation = 0

/**
 * The activation is gone: the flow has to unwind.
 *
 * The guarded context does not open a dialog that belongs to a plugin that is
 * no longer on screen: it would draw over the one that replaced it. A flow
 * waiting for an answer therefore has to be told, or it waits for a dialog
 * that will never open - and a loop that asks again on every empty answer
 * never ends.
 */
class ActivationGone extends Error {
  constructor() {
    super("The relay plugin was reloaded.")
    this.name = "ActivationGone"
  }
}

/** Marks a context whose activation is gone, so a flow can stop waiting. */
const ACTIVATION_GONE = Symbol("relay-activation-gone")

/** Start an activation, and return the token that names it. */
export function beginActivation(): number {
  activation += 1
  // A new activation starts a new generation: an answer that was already on
  // its way belongs to the plugin that is gone, and must not paint the
  // footer of the one that replaced it.
  resetRefresh()
  return activation
}

/** End an activation: everything it started stops touching the screen. */
export function endActivation(token: number): void {
  // Only the activation that is on screen ends itself: a cleanup that runs
  // after the host has already set up the replacement must not wipe the new
  // activation's footer state or its refresh latch.
  if (token === activation) {
    activation += 1
    // The footer goes quiet, and the refresh latch is released: the same
    // reset a new activation would do for itself, done here for one whose
    // cleanup really is the last one.
    clearState()
    resetRefresh()
  }
}

/**
 * A copy of an object that keeps its prototype.
 *
 * The host's objects may carry their methods on the prototype, and a plain
 * spread would drop them.
 */
function withPrototype<T extends object>(source: T, overrides: Partial<T>): T {
  return Object.assign(Object.create(Object.getPrototypeOf(source)), source, overrides) as T
}

/**
 * A context whose screen operations do nothing once the activation is gone.
 *
 * The context is copied rather than changed, so the plugin that replaced
 * this one keeps the one the host handed it.
 */
function guardContext(context: Context, token: number): Context {
  const alive = (): boolean => token === activation
  const ui = context.ui
  const guardedUi = withPrototype(ui, {
    toast: withPrototype(ui.toast, {
      show: (options: ToastOptions): void => {
        if (!alive()) return
        ui.toast.show(options)
      },
    }),
    dialog: withPrototype(ui.dialog, {
      show: (...args: Parameters<typeof ui.dialog.show>): void => {
        if (!alive()) return
        ui.dialog.show(...args)
      },
      set: (options: DialogOptions): void => {
        if (!alive()) return
        ui.dialog.set(options)
      },
      clear: (): void => {
        if (!alive()) return
        ui.dialog.clear()
      },
      alert: async (options: DialogAlertOptions): Promise<void> => {
        if (!alive()) throw new ActivationGone()
        await ui.dialog.alert(options)
        if (!alive()) throw new ActivationGone()
      },
      confirm: async (options: DialogConfirmOptions): Promise<boolean | undefined> => {
        if (!alive()) throw new ActivationGone()
        const answer = await ui.dialog.confirm(options)
        // The answer may arrive after the plugin was reloaded: the flow it
        // belongs to is gone, and what it would do with the answer is not
        // the plugin's business any more.
        if (!alive()) throw new ActivationGone()
        return answer
      },
      prompt: async (options: DialogPromptOptions): Promise<string | undefined> => {
        if (!alive()) throw new ActivationGone()
        const answer = await ui.dialog.prompt(options)
        if (!alive()) throw new ActivationGone()
        return answer
      },
      select: async <Value,>(
        options: DialogSelectOptions<Value>,
      ): Promise<Value | undefined> => {
        if (!alive()) throw new ActivationGone()
        const choice = await ui.dialog.select<Value>(options)
        if (!alive()) throw new ActivationGone()
        return choice
      },
    }),
  })
  const guarded = withPrototype(context, { ui: guardedUi })
  // The flows that wait for a dialog of their own ask this before they
  // start: a dialog that never opens would leave them waiting forever.
  Object.defineProperty(guarded, ACTIVATION_GONE, { value: () => !alive() })
  return guarded
}

/** Whether the activation behind this context is still on screen. */
function activationGone(context: Context): boolean {
  const check = (context as Context & { readonly [ACTIVATION_GONE]?: () => boolean })[
    ACTIVATION_GONE
  ]
  return check !== undefined && check()
}

export async function openRelayMenu(
  context: Context,
  client: RelayClient,
  token: number,
): Promise<void> {
  // Everything this menu shows goes through the guarded context, so a reload
  // in the middle of a flow cannot leave the old flow drawing over the new
  // one.
  const screen = guardContext(context, token)
  // A second click on the pill, or a second /relay while the menu is up, must
  // not stack menus on top of each other.
  if (menuOwner !== undefined) {
    screen.ui.toast.show({ title: "Relay", message: "The relay menu is already open.", variant: "info" })
    return
  }
  menuOwner = token
  try {
    // One toaster for the whole menu, so a dead server is reported once and
    // not again by every submenu the user walks into.
    const reportRefresh = refreshErrorToaster(screen)
    const staleNote = " · last known state"
    for (;;) {
      // The menu is drawn from a fresh snapshot, so the title's claim about
      // freshness matches the options it labels. A server that was not
      // answering has nothing to add, so the menu opens at once with the
      // snapshot it has, labelled as the last thing known.
      const answering = isReachable()
      const refreshed = answering
        ? await withWorking(screen, "Reading the relay", () => refreshStatus(screen, client))
        : undefined
      if (refreshed !== undefined && !refreshed.ok) reportRefresh(refreshed)
      let status = refreshed?.ok === true ? refreshed.status : currentStatus()
      // Whether the state on screen is the state now: only a fresh answer
      // says so, and a snapshot from a server that is not answering is the
      // last thing known.
      let current = refreshed?.ok === true
      if (status === undefined) {
        // There is no snapshot at all, so the server has to answer before
        // there is anything to draw.
        const first = await withWorking(screen, "Reading the relay", () =>
          refreshStatus(screen, client),
        )
        if (!first.ok) {
          reportError(screen, "Relay", first.error)
          return
        }
        status = first.status
        current = true
      }
      const choice = await screen.ui.dialog.select<MenuAction>({
        title: `Relay${current ? "" : staleNote}`,
        options: menuOptions(status),
      })
      if (choice === undefined || choice === "close") return
      await runAction(screen, client, choice, reportRefresh)
    }
  } catch (error) {
    // The plugin was reloaded while the menu was open: the flow has nothing
    // left to show, and the plugin that replaced it owns the screen now.
    if (!(error instanceof ActivationGone)) throw error
  } finally {
    // Only the menu that owns the guard releases it: a menu that was
    // replaced by a newer one must not unlock the newer one's guard.
    if (menuOwner === token) menuOwner = undefined
  }
}

/** Runs one entry of the main menu. */
async function runAction(
  context: Context,
  client: RelayClient,
  choice: MenuAction,
  reportRefresh: (refresh: Refresh) => void,
): Promise<void> {
  switch (choice) {
    case "status":
      return showStatus(context, client)
    case "toggle": {
      // Toggle needs the state it acts on; the rest is in the submenu.
      const refreshed = await withWorking(context, "Reading the relay", () =>
        refreshStatus(context, client),
      )
      if (refreshed.ok) return toggleRouting(context, client, refreshed.status)
      const fallback = currentStatus()
      if (fallback) return toggleRouting(context, client, fallback)
      return
    }
    case "models":
      return chooseModels(context, client, reportRefresh)
    case "exits":
      return manageExits(context, client, reportRefresh)
    case "settings":
      return openSettings(context, client, reportRefresh)
    case "preview":
      return showPreview(context, client)
  }
}

/** What one entry of the Settings submenu does. */
type SettingsAction =
  | "strategy"
  | "direct"
  | "health"
  | "transfer"
  | "add-account"
  | "remove-account"
  | "back"

/** The Settings hub: the rarely-changed rules, each one step deep. */
async function openSettings(
  context: Context,
  client: RelayClient,
  reportRefresh: (refresh: Refresh) => void,
): Promise<void> {
  for (;;) {
    const refreshed = await withWorking(context, "Reading the relay", () =>
      refreshStatus(context, client),
    )
    const status = refreshed.ok ? refreshed.status : currentStatus()
    if (!status) return
    if (!refreshed.ok) reportRefresh(refreshed)
    const options: DialogSelectOption<SettingsAction>[] = [
      {
        title: "How exits are used",
        value: "strategy",
        description: describeStrategy(status),
      },
      {
        title: "When no exit can serve",
        value: "direct",
        description: status.direct === "allow" ? "Now: go direct" : "Now: fail instead of going direct",
      },
      {
        title: `Background checks: ${status.healthChecks !== false ? "on" : "off"}`,
        value: "health",
        description: status.healthChecks !== false ? "Automatic checks every 10 minutes while routing is on" : "Only when you ask",
      },
      { title: "Export or import", value: "transfer", description: "Move exits and rules between machines" },
      { title: "Add a Vercel account", value: "add-account", description: "Needs a Vercel API token" },
      ...(status.accounts.length > 0
        ? [
            {
              title: "Remove a Vercel account",
              value: "remove-account" as const,
              description: "Relays it deployed keep running",
            },
          ]
        : []),
      { title: "Back", value: "back" },
    ]
    const choice = await context.ui.dialog.select<SettingsAction>({
      title: `Settings${refreshed.ok ? "" : " · last known state"} · ${describeSettings(status)}`,
      options,
    })
    if (choice === undefined || choice === "back") return
    switch (choice) {
      case "strategy":
        await chooseStrategy(context, client, status)
        continue
      case "direct":
        await chooseDirect(context, client, status)
        continue
      case "health":
        await toggleHealthChecks(context, client, status)
        continue
      case "transfer":
        await transferConfig(context, client)
        continue
      case "add-account":
        await addAccount(context, client)
        continue
      case "remove-account":
        await removeAccount(context, client, status)
        continue
    }
  }
}

/** The read-only page about everything the plugin knows right now. */
async function showStatus(context: Context, client: RelayClient): Promise<void> {
  const refreshed = await withWorking(context, "Reading the relay", () =>
    refreshStatus(context, client),
  )
  const status = refreshed.ok ? refreshed.status : currentStatus()
  if (!status) {
    if (!refreshed.ok) reportError(context, "Relay", refreshed.error)
    return
  }
  const lines: string[] = []
  if (!refreshed.ok) {
    // The page is a snapshot; a reader has to know it may be a stale one.
    lines.push("This is the last known state: the server did not answer.")
    lines.push("")
  }
  await showText(context, "Relay status", `${lines.length > 0 ? `${lines.join("\n")}\n` : ""}${describeStatusPage(status)}`, "xlarge")
}

/** Turn routing on or off. */
async function toggleRouting(context: Context, client: RelayClient, status: RelayStatus): Promise<void> {
  const enabled = !status.enabled
  const result = await callRpc(context, "Relay", () => client.setEnabled({ enabled }))
  if (!result) return
  const refreshed = await withWorking(context, "Reading the relay", () =>
    refreshStatus(context, client),
  )
  const note = refreshed.ok ? refreshed.status.note : undefined
  const summary = enabled ? "Routing is on." : "Routing is off."
  // The server's own note begins with the same words the summary uses, so
  // printing both said the same thing twice. When the note stands on its
  // own it is the whole message.
  const stem = summary.replace(/\.$/, "")
  const head = note?.trimStart().toLowerCase() ?? ""
  // The server's own note begins with the same words the summary uses, so
  // printing both said the same thing twice. When the note stands on its
  // own it is the whole message. The healthy note names the models instead
  // of repeating the summary - it starts with "Routing " and continues the
  // same sentence - so it counts as a continuation too.
  const continues = enabled && head.startsWith("routing ")
  const message =
    note === undefined
      ? summary
      : head.startsWith(stem.toLowerCase()) || continues
        ? note
        : `${summary} ${note}`
  context.ui.toast.show({
    title: "Relay",
    message,
    variant: "success",
    ...(enabled && note ? { duration: 8000 } : {}),
  })
}

/**
 * What one strategy does, in a line the host will not clip.
 *
 * The labels in `lib/types.ts` are full sentences for a page; a menu row
 * only has room for one short clause, and a clipped clause reads worse than
 * none at all.
 */
const STRATEGY_NOTES: Record<Strategy, string> = {
  fixed: "Prefers the exit you chose",
  "round-robin": "Requests rotate over the exits",
  exhausted: "One exit until it is used up",
  fastest: "The lowest recent latency wins",
}

/** Choose how the exits are used. */
async function chooseStrategy(context: Context, client: RelayClient, status: RelayStatus): Promise<void> {
  const options = STRATEGIES.map(
    (strategy): DialogSelectOption<Strategy> => ({
      title: STRATEGY_LABELS[strategy].title,
      value: strategy,
      description: STRATEGY_NOTES[strategy],
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
        description: "OpenCode sees this machine's address",
      },
      {
        title: "Never go direct",
        value: "never",
        description: "Nothing leaves without an exit",
      },
    ],
    current: status.direct,
  })
  if (choice === undefined) return
  const result = await callRpc(context, "Relay", () => client.setDirect({ direct: choice }))
  if (!result) return
  context.ui.toast.show({
    title: "Relay",
    // The policy is dormant while routing is off: no request goes through an
    // exit, so nothing fails yet, and saying it does would be a wrong word.
    message:
      choice === "never"
        ? status.enabled
          ? "Direct routing is off: a request with no usable exit now fails."
          : "Direct routing is off: when routing is on, a request with no usable exit fails."
        : "Direct routing is allowed: requests fall back to OpenCode when no exit can serve.",
    variant: choice === "never" ? "warning" : "success",
  })
  await refreshStatus(context, client)
}

/** Show where the next request would go, without sending anything. */
async function showPreview(context: Context, client: RelayClient): Promise<void> {
  // The model the prompt is pointed at, so the preview is about the request
  // the user is about to make. A model of another provider previews as "only
  // the opencode provider is routed", which is the truth and not a claim that
  // this model would go through an exit.
  const current = context.ui.model.current()
  // The preview reads the provider's model list, which can hang behind a
  // blocked network: the call has a deadline, and the work is shown while it
  // runs, so the menu never appears to have done nothing.
  const result = await withWorking(context, "Reading the routing", () =>
    callRpc(context, "Relay", () =>
      withDeadline(
        (signal) =>
          client.preview(
            current ? { modelId: current.modelID, providerID: current.providerID } : {},
            { signal },
          ),
        STATUS_TIMEOUT_MS,
      ),
    ),
  )
  if (!result) return
  // The page says what would happen next; what happened last belongs to the
  // status page, where it is not read as a prediction.
  await showText(context, "The next request", describePreview(result), "large")
}

/** Bring the exits whose allowance is gone back into use. */
async function restoreExhausted(context: Context, client: RelayClient, status: RelayStatus): Promise<void> {
  const result = await callRpc(context, "Relay", () => client.resetExhausted({}))
  if (!result) return
  const restored = result.restored.length
  const left = (result.stillUsedUp ?? []).length
  const parts: string[] = []
  if (restored > 0) {
    // Only a relay can be asked for a fresh address, and only a relay that
    // was actually restored is asked: a proxy-only restore would claim a
    // move that never happens.
    const relayed = result.restored.some((id) =>
      status.exits.some((exit) => exit.id === id && exit.kind === "relay"),
    )
    parts.push(
      `${restored} exit${restored === 1 ? " is" : "s are"} no longer counted as used up${relayed ? ", and a relay is asked to move to a fresh address" : ""}.`,
    )
  }
  if (left > 0) {
    // The user asked for these to come back and they did not: saying so is
    // the difference between an answer and a silent refusal.
    parts.push(
      `${left} exit${left === 1 ? " is" : "s are"} still out of use: the provider's reset window is live, so there is nothing to come back from yet.`,
    )
  }
  if (result.error !== undefined) {
    // The restore stopped partway: the exits that were restored are in force,
    // and the ones that were not are still out of use. The toast says both.
    parts.push(result.error)
  }
  context.ui.toast.show({
    title: "Relay",
    message: parts.length > 0 ? parts.join(" ") : "No exit was out of use.",
    // Nothing happened is not a success: the reader must not read it as one.
    // A restore that stopped partway is not a success either.
    variant: restored > 0 && result.error === undefined ? "success" : "warning",
    duration: parts.length > 1 ? 9000 : 7000,
  })
  // The Exits list refreshes as soon as this returns, so a refresh here would
  // only ask the server the same question twice.
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
      ? "Background checks are on: exits are checked every 10 minutes while routing is on."
      : "Background checks are off. Exits are only checked when you ask.",
    variant: "success",
  })
  await refreshStatus(context, client)
}

/** Let the user say which models go through the exits. Only free models are ever routed. */
async function chooseModels(
  context: Context,
  client: RelayClient,
  reportRefresh: (refresh: Refresh) => void,
): Promise<void> {
  // The model list is read from the provider, which can hang behind a
  // blocked network: the call has a deadline, and the work is shown while it
  // runs, so the menu never appears to have done nothing.
  const result = await withWorking(context, "Reading the model list", () =>
    callRpc(context, "Relay", () => withDeadline((signal) => client.models({}, { signal }), STATUS_TIMEOUT_MS)),
  )
  if (!result) return
  const models = result.models
  const free = models.filter((model) => model.free)
  if (free.length === 0) {
    await context.ui.dialog.alert({
      title: "No free models",
      message:
        models.length === 0
          ? "The OpenCode provider's model list is empty or could not be read. The plugin cannot tell which models are free, so nothing is routed."
          : "The OpenCode provider lists no free model right now. The plugin only routes free models.",
    })
    return
  }
  for (;;) {
    // The loop needs the current selection to describe the choices and to
    // pre-mark the right one; the initial fetch says what that is.
    const refreshed = await withWorking(context, "Reading the relay", () =>
      refreshStatus(context, client),
    )
    const status = refreshed.ok ? refreshed.status : currentStatus()
    if (!status) return
    // A refresh that failed leaves the loop on an old snapshot, so the
    // reader is told, exactly as the sibling hubs tell them.
    if (!refreshed.ok) reportRefresh(refreshed)
    const paid = models.length - free.length
    const current: "free" | "pick" = status.selection === "free" ? "free" : "pick"
    const choice = await context.ui.dialog.select<"free" | "pick" | "back">({
      title: `Models${refreshed.ok ? "" : " · last known state"}`,
      options: [
        {
          title: "Route every free model",
          value: "free",
          description:
            status.selection === "free"
              ? describeSelection(status)
              : paid > 0
                ? "Paid models are never routed"
                : "The provider lists no paid model",
        },
        {
          title: "Choose free models one by one",
          value: "pick",
          description:
            status.selection === "custom"
              ? `${status.routedCount} chosen of ${free.length} free models`
              : "Pick which free models are routed",
        },
        { title: "Back", value: "back" },
      ],
      current,
    })
    if (choice === undefined || choice === "back") return
    if (choice === "free") {
      await setSelection(context, client, { selection: "free" })
      continue
    }
    // Under "route every free model" the stored list is not what is routed:
    // every free model is. The picker has to start from what is actually
    // routed, or every row would read "not routed" and saving would drop the
    // models that are in use.
    await pickModels(
      context,
      client,
      free,
      status.selection === "free" ? free.map((model) => model.id) : status.customModels,
    )
  }
}

/** The extra entries above the model list that set every mark at once. */
type PickerChoice =
  | { readonly kind: "all" }
  | { readonly kind: "none" }
  | { readonly kind: "model"; readonly id: string }
  | { readonly kind: "done" }

/** Ask about one free model at a time until the user says they are done. */
async function pickModels(
  context: Context,
  client: RelayClient,
  models: readonly RelayModel[],
  initial: readonly string[],
): Promise<void> {
  let picked = new Set(initial.filter((id) => models.some((model) => model.id === id)))
  const baseline = [...picked]
  const unchanged = () =>
    picked.size === baseline.length && baseline.every((id) => picked.has(id))
  let current: PickerChoice | undefined
  for (;;) {
    const options: DialogSelectOption<PickerChoice>[] = [
      {
        title: "Select all",
        value: { kind: "all" },
        description: `Mark all ${models.length} free models as routed`,
      },
      {
        title: "Clear selection",
        value: { kind: "none" },
        description: "Clear every marked model",
      },
      ...models.map(
        (model): DialogSelectOption<PickerChoice> => ({
          title: model.name,
          value: { kind: "model", id: model.id },
          // The list holds free models only and its title carries the count,
          // so a row only has to say whether this model is routed. An id is
          // any length and would be clipped.
          description: picked.has(model.id) ? "routed" : "not routed",
        }),
      ),
      { title: "Done", value: { kind: "done" }, description: "Save this selection" },
    ]
    const choice = await context.ui.dialog.select<PickerChoice>({
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
    if (choice.kind === "all") {
      // Setting every mark at once is the one change that has to re-render
      // the whole list, so the loop restarts instead of confirming.
      for (const model of models) picked.add(model.id)
      continue
    }
    if (choice.kind === "none") {
      picked.clear()
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
    // The question asks for the opposite of what the model is doing now, so
    // the answer has to be read against the current state: confirming "Stop
    // routing" unroutes the model, and confirming "Route it" routes it.
    if (answer) picked = new Set(toggleModel(picked, model.id, routed))
  }
  await setSelection(context, client, { selection: "custom", models: [...picked] })
}

/** Tell the server which models are routed. */
async function setSelection(
  context: Context,
  client: RelayClient,
  input: { readonly selection: "free" | "custom"; readonly models?: readonly string[] },
): Promise<void> {
  // The server reads the provider's model list on this call, which can hang
  // behind a blocked network: the call has a deadline and says what it is
  // doing, so the menu never looks as if it did nothing.
  const result = await withWorking(context, "Saving the selection", () =>
    callRpc(context, "Relay", () =>
      withDeadline((signal) => client.setSelection(input, { signal }), STATUS_TIMEOUT_MS),
    ),
  )
  if (!result) return
  const count = result.customModels.length
  const dropped = result.dropped.length
  // The ids may not have been checked against the price list: the list could
  // not be read, and calling them free then would be a claim the server
  // cannot make.
  const unverified = result.verified === false
  const message =
    result.selection === "free"
      ? `The free models are routed${dropped > 0 ? `; ${dropped} paid model${dropped === 1 ? " was" : "s were"} left out` : ""}.`
      : count === 0
        ? "No model is routed. Choose at least one."
        : unverified
          ? `${count} model${count === 1 ? " is" : "s are"} routed, but the model list could not be read, so ${count === 1 ? "it is" : "they are"} not known to be free.`
          : `${count} free model${count === 1 ? " is" : "s are"} routed${dropped > 0 ? `; ${dropped} could not be routed, because ${dropped === 1 ? "it is" : "they are"} not free` : ""}.`
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
    // The words are the ones every other surface uses: "Reachable" alone
    // reads as working, and this check did not try a model request.
    const kind =
      result.status === "reachable"
        ? "Reachable, not model-tested"
        : result.status === "ready"
          ? "Ready"
          : statusLabel(result.status)
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
function testAction(context: Context, client: RelayClient): DialogSelectAction<ExitListAction> {
  return {
    bind: "t",
    title: "test",
    side: "left",
    selection: "required",
    onTrigger: (value) => {
      // A list-level row has no exit behind it: saying so would claim that
      // the cursor is on something it is not. A keypress that looks offered
      // must say something.
      if (!("id" in value)) {
        context.ui.toast.show({
          title: "Relay",
          message: "Move to an exit to test it.",
          variant: "info",
        })
        return
      }
      void quickTest(context, client, value)
    },
  }
}

/**
 * Redeploy one exit from the list, without ever opening a dialog.
 *
 * The list is still open while this runs: an action handler must not take
 * the dialog out from under the select that is waiting on it, so the work
 * says what it is doing in a toast and the list keeps its own loop.
 */
async function quickUpdate(context: Context, client: RelayClient, exit: ExitChoice): Promise<void> {
  context.ui.toast.show({ title: "Relay", message: `Updating ${exit.name}...`, variant: "info" })
  const result = await callRpc(context, "Relay", () => client.updateRelay({ id: exit.id }))
  if (!result) return
  context.ui.toast.show({
    title: "Relay",
    // A relay that answered with a status has a problem of its own - a wrong
    // access token, most of all - and "did not answer" would send the user
    // looking in the wrong place.
    message: result.reachable
      ? `${exit.name} is redeployed and answered.`
      : result.status !== undefined && result.status > 0
        ? `${exit.name} is redeployed, but it answered HTTP ${result.status}.`
        : `${exit.name} is redeployed, but did not answer yet.`,
    variant: result.reachable ? "success" : "warning",
    duration: result.reachable ? 6000 : 9000,
  })
  void refreshStatus(context, client)
}

/** The key binding that redeploys the relay the cursor is on. */
function updateAction(context: Context, client: RelayClient): DialogSelectAction<ExitListAction> {
  return {
    bind: "u",
    title: "update",
    side: "left",
    selection: "required",
    onTrigger: (value) => {
      // A list-level row has no relay behind it: saying so would claim that
      // the cursor is on something it is not.
      if (!("id" in value)) {
        context.ui.toast.show({
          title: "Relay",
          message: "Move to a relay to update it.",
          variant: "info",
        })
        return
      }
      // Only a deployed relay whose Vercel account is still stored can be
      // redeployed: a proxy or a tracked relay has no project to push code
      // to, and a deployed relay whose account is gone cannot be reached.
      if (value.deployed !== true) {
        context.ui.toast.show({
          title: "Relay",
          message: "Only a deployed relay whose Vercel account is still stored can be updated.",
          variant: "warning",
        })
        return
      }
      void quickUpdate(context, client, value)
    },
  }
}

/** What one entry of the Add-exits submenu does. */
type AddExitAction = "deploy" | "track" | "proxies" | "back"

/** The Add-exits hub: three ways to get another address. */
async function addExits(context: Context, client: RelayClient): Promise<void> {
  for (;;) {
    const choice = await context.ui.dialog.select<AddExitAction>({
      title: "Add exits",
      options: [
        { title: "Deploy a relay", value: "deploy", description: "One Vercel project per region" },
        { title: "Track an existing relay", value: "track", description: "Use a relay you deployed yourself" },
        { title: "Add proxies", value: "proxies", description: "Paste HTTP, HTTPS or SOCKS proxies" },
        { title: "Back", value: "back" },
      ],
    })
    if (choice === undefined || choice === "back") return
    switch (choice) {
      case "deploy":
        await deployRelay(context, client)
        continue
      case "track":
        await trackRelay(context, client)
        continue
      case "proxies":
        await addProxies(context, client)
        continue
    }
  }
}

/** The relays and proxies, and what can be done with each. */
async function manageExits(
  context: Context,
  client: RelayClient,
  reportRefresh: (refresh: Refresh) => void,
): Promise<void> {
  for (;;) {
    const refreshed = await withWorking(context, "Reading the relay", () =>
      refreshStatus(context, client),
    )
    const status = refreshed.ok ? refreshed.status : currentStatus()
    if (!status) return
    if (!refreshed.ok) reportRefresh(refreshed)
    const active = status.activeExit
    // The dialog finds the pre-selected row by deep equality with the option
    // values, so this carries the same deployed flag exitList sets.
    const current: ExitChoice | undefined =
      active === undefined
        ? undefined
        : {
            id: active.id,
            name: active.name,
            kind: active.kind,
            deployed: active.kind === "relay" && isDeployedExit(active, status),
          }
    const choice = await context.ui.dialog.select<ExitListAction>({
      title: `Exits${refreshed.ok ? "" : " · last known state"}`,
      options: exitsMenuOptions(status),
      ...(current !== undefined ? { current } : {}),
      actions: [testAction(context, client), updateAction(context, client)],
    })
    if (choice === undefined) return
    if (!("id" in choice)) {
      switch (choice.kind) {
        case "add":
          await addExits(context, client)
          continue
        case "test-all":
          await startTestAll(context, client, false)
          continue
        case "test-all-deep":
          await startTestAll(context, client, true)
          continue
        case "update-all":
          await updateAllRelays(context, client)
          continue
        case "restore":
          await restoreExhausted(context, client, status)
          continue
        case "resume-all":
          await resumeAllPaused(context, client, status.paused ?? [])
          continue
        case "back":
          return
      }
    }
    await exitDetail(context, client, choice.id, reportRefresh)
  }
}

/** Everything that can be done with one exit. */
type DetailAction = "details" | "use" | "test" | "deep" | "toggle" | "update" | "edit" | "remove" | "back"

async function exitDetail(
  context: Context,
  client: RelayClient,
  id: string,
  reportRefresh: (refresh: Refresh) => void,
): Promise<void> {
  for (;;) {
    const refreshed = await withWorking(context, "Reading the relay", () =>
      refreshStatus(context, client),
    )
    const status = refreshed.ok ? refreshed.status : currentStatus()
    if (!status) return
    if (!refreshed.ok) reportRefresh(refreshed)
    const exit = status.exits.find((item) => item.id === id)
    if (!exit) {
      context.ui.toast.show({ title: "Relay", message: "That exit is not there any more.", variant: "warning" })
      return
    }
    const exhausted = status.exhausted.includes(id)
    const chosen = status.activeExit?.id === id
    // A paused exit is kept but never used, so offering it as the exit to use
    // would toast a choice that routing is about to skip.
    const paused = !exit.enabled
    const hasSample = status.hasRequestSample === true
    const isDeployedRelay = isDeployedExit(exit, status)
    const options: DialogSelectOption<DetailAction>[] = [
      {
        title: "Details",
        value: "details",
        description: "Address, health, traffic, last error",
      },
      {
        title: exhausted ? "Choose it for when it resets" : "Use this exit",
        value: "use",
        description: chosen
          ? "Already the chosen exit"
          : paused
            ? "Paused: resume it first"
            : exhausted
              ? "Bringing used-up exits back clears this"
              : "For one-exit and until-exhausted",
        ...(chosen || paused ? { disabled: true } : {}),
      },
      {
        title: "Test through OpenCode",
        value: "test",
        description: "Checks OpenCode through this exit",
      },
      {
        title: "Deep test with a real model",
        value: "deep",
        // The check carries the session token, and a paused exit is out of
        // use on purpose: the token has no business going there. It also
        // replays a captured request's headers, so without a capture there
        // is nothing to send.
        description: paused
          ? "Paused: resume it first"
          : hasSample
            ? "The only check with a real model request"
            : "Needs a routed request first",
        ...(paused || !hasSample ? { disabled: true } : {}),
      },
      {
        title: exit.enabled ? "Pause this exit" : "Resume this exit",
        value: "toggle",
        description: exit.enabled
          ? "Keep it, but stop using it"
          : "Use it again in routing and checks",
      },
      ...(isDeployedRelay
        ? [
            {
              title: "Update this relay",
              value: "update" as const,
              description: "Redeploy the code; URL and token stay",
            },
          ]
        : []),
      ...(exit.kind === "proxy"
        ? [{ title: "Edit its name or address", value: "edit" as const, description: "A new address is tested afresh" }]
        : []),
      {
        title: "Remove this exit",
        value: "remove",
        // The question about the Vercel project is only asked when there is
        // one to ask about: promising it for a proxy would be a wrong
        // promise.
        description: isDeployedRelay
          ? "The Vercel project is asked about"
          : "Only this plugin forgets it",
      },
      { title: "Back", value: "back" },
    ]
    const choice = await context.ui.dialog.select<DetailAction>({
      // The server's own label knows about the reset time; the fallback only
      // fills the gap when the record did not say.
      title: `${exit.name}${refreshed.ok ? "" : " · last known state"} - ${
        (exit.statusLabel ?? "").length > 0 ? exit.statusLabel : statusLabel(exit.status)
      }`,
      options,
    })
    if (choice === undefined || choice === "back") return

    switch (choice) {
      case "details": {
        await showText(context, exit.name, describeExitDetails(exit, status), "large")
        break
      }
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
        // A deep check carries the user's OpenCode session token, so it is
        // said out loud before it happens, the same as the batch path — and
        // the token exists only when a routed request has been captured for
        // it to replay.
        const sure = await context.ui.dialog.confirm({
          title: `Send a real request through ${exit.name}?`,
          message: hasSample
            ? "This sends your OpenCode session token through this exit. It is the only check that can tell an address that works from one whose allowance is gone."
            : "No routed request has been captured in the last 30 minutes, so there are no headers to send. Route one request through any exit first.",
          label: hasSample
            ? { confirm: "Send it", cancel: "Not now" }
            : { confirm: "Got it", cancel: "Not now" },
        })
        if (!sure) break
        // The capture may have aged out while the dialog was open: the check
        // has no headers to send then, and a call that cannot work is not
        // worth making after the user agreed to one.
        if (currentStatus()?.hasRequestSample !== true) {
          context.ui.toast.show({
            title: "Relay",
            message:
              "No routed request has been captured in the last 30 minutes, so there are no headers to send.",
            variant: "warning",
          })
          break
        }
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
        // The picker answers whether the exit will serve now, and only a
        // fresh answer can: a paused exit is skipped for being paused, and
        // resuming it does not make it serve when its allowance is gone.
        const refreshed = await withWorking(context, "Reading the relay", () =>
          refreshStatus(context, client),
        )
        const live = refreshed.ok ? refreshed.status : status
        const now = live.exits.find((item) => item.id === id)
        const serves = now !== undefined && isUsableExit(now, live)
        context.ui.toast.show({
          title: "Relay",
          // Resuming an exit does not make it serve: one whose allowance is
          // gone, or that is resting, stays out of use. The toast says what
          // changed, and what is still true.
          message: exit.enabled
            ? `${exit.name} is paused.`
            : result.enabled
              ? `${exit.name} is no longer paused.${serves ? "" : " It is not in use right now."}`
              : `${exit.name} is still paused.`,
          variant: "success",
        })
        break
      }
      case "update": {
        await updateRelay(context, client, id, exit.name)
        break
      }
      case "edit": {
        await editProxy(context, client, id, exit.name, exit.url)
        break
      }
      case "remove": {
        await removeExit(context, client, exit, status)
        return
      }
    }
  }
}

/** Redeploy one relay with the current code, and say whether it answered. */
async function updateRelay(
  context: Context,
  client: RelayClient,
  id: string,
  name: string,
): Promise<void> {
  const result = await withWorking(context, `Updating ${name}`, () =>
    callRpc(context, "Relay", () => client.updateRelay({ id })),
  )
  if (!result) return
  context.ui.toast.show({
    title: "Relay",
    // A relay that answered with a status has a problem of its own, and
    // "did not answer" would send the user looking in the wrong place.
    message: result.reachable
      ? `${name} is redeployed and answered.`
      : result.status !== undefined && result.status > 0
        ? `${name} is redeployed, but it answered HTTP ${result.status}.`
        : `${name} is redeployed, but did not answer yet.`,
    variant: result.reachable ? "success" : "warning",
  })
  await refreshStatus(context, client)
}

/** Change a proxy's name or address. */
async function editProxy(
  context: Context,
  client: RelayClient,
  id: string,
  name: string,
  url: string,
): Promise<void> {
  const askedName = await context.ui.dialog.prompt({
    title: "Name this proxy",
    description: "A name you will recognize later.",
    placeholder: name,
    value: name,
  })
  if (askedName === undefined) return
  let nextName = askedName
  let changed = false
  if (nextName.trim().length > 0 && nextName.trim() !== name) {
    for (;;) {
      const updated = await callRpc(context, "Relay", () =>
        client.updateProxy({ id, name: nextName.trim() }),
      )
      if (updated === undefined) {
        // The call itself failed. The name is the user's own word, and a
        // retry that has to retype it is a retry they may not make, so it is
        // offered again with what was typed already in the box.
        const again = await context.ui.dialog.prompt({
          title: "Name this proxy",
          description: "A name you will recognize later.",
          placeholder: name,
          value: nextName,
        })
        if (again === undefined) return
        nextName = again
        if (nextName.trim().length === 0 || nextName.trim() === name) return
        continue
      }
      if (updated.updated) {
        changed = true
        break
      }
      // The server refused the name and says why: its own words are the
      // answer, and the name is offered again so it can be corrected.
      context.ui.toast.show({
        title: "Relay",
        message: updated.reason ?? `${name} is not stored any more, so its name was not changed.`,
        variant: "warning",
      })
      const again = await context.ui.dialog.prompt({
        title: "Name this proxy",
        description: "A name you will recognize later.",
        placeholder: name,
        value: nextName,
      })
      if (again === undefined) {
        await refreshStatus(context, client)
        return
      }
      nextName = again
      if (nextName.trim().length === 0 || nextName.trim() === name) {
        await refreshStatus(context, client)
        return
      }
    }
  }
  const askedUrl = await context.ui.dialog.prompt({
    title: "Proxy address",
    description: "host:port or a proxy URL with scheme, credentials included",
    // The address is shown with its credentials masked, so it must not be
    // prefilled into an editable field: submitting it back would store the
    // mask as the password and quietly break the proxy. The current address
    // is a placeholder, and an empty answer keeps it as it is.
    placeholder: url,
  })
  if (askedUrl === undefined) {
    // The name was already saved, so the flow has to say so: a silent return
    // reads as a lost answer.
    if (changed) {
      context.ui.toast.show({
        title: "Relay",
        message: `${name} was renamed; the address was left as it was.`,
        variant: "success",
      })
      await refreshStatus(context, client)
    }
    return
  }
  let nextUrl = askedUrl
  if (nextUrl.trim().length > 0) {
    for (;;) {
      const updated = await withWorking(context, "Testing the new address", () =>
        callRpc(context, "Relay", () => client.updateProxy({ id, url: nextUrl.trim() })),
      )
      // The name may already have changed: the list must show it either way.
      if (updated === undefined) {
        // The call itself failed. The address is the user's own text, and a
        // retry that has to retype it is a retry they may not make, so it is
        // offered again with what was typed already in the box.
        const again = await context.ui.dialog.prompt({
          title: "Proxy address",
          description: "host:port or a proxy URL with scheme, credentials included",
          placeholder: url,
          value: nextUrl,
        })
        if (again === undefined) {
          // The name was already saved, so the flow has to say so: a silent
          // return reads as a lost answer.
          if (changed) {
            context.ui.toast.show({
              title: "Relay",
              message: `${name} was renamed; the address was left as it was.`,
              variant: "success",
            })
            await refreshStatus(context, client)
          }
          return
        }
        nextUrl = again
        if (nextUrl.trim().length === 0) {
          if (changed) {
            context.ui.toast.show({
              title: "Relay",
              message: `${name} was renamed; the address was left as it was.`,
              variant: "success",
            })
            await refreshStatus(context, client)
          }
          return
        }
        continue
      }
      if (!updated.updated) {
        // A reason means the server refused the address; without one nothing
        // changed, which is not an error.
        context.ui.toast.show({
          title: "Relay",
          // The rename may have landed before the address was refused: saying
          // only "the address was left" would drop a change already stored.
          message:
            updated.reason !== undefined
              ? changed
                ? `${updated.reason} ${name} was renamed; the address was left as it was.`
                : `${updated.reason} The address was left as it was.`
              : changed
                ? `${name} was renamed; the address was left as it was.`
                : "That is the address it already had. Nothing changed.",
          variant: updated.reason !== undefined ? "error" : changed ? "success" : "info",
        })
        if (changed) await refreshStatus(context, client)
        return
      }
      context.ui.toast.show({
        title: "Relay",
        // The rename and the address can change in one flow: saying only
        // what the last step did would make the first look lost.
        message: changed
          ? `${name} was renamed, and the new address is being checked.`
          : "The address was changed and is being checked.",
        variant: "success",
      })
      await refreshStatus(context, client)
      return
    }
  }
  // The name changed and the address was left as it was: say so, rather than
  // a bare refresh that reads like a lost answer.
  if (!changed) {
    context.ui.toast.show({ title: "Relay", message: "Nothing changed.", variant: "info" })
    return
  }
  context.ui.toast.show({
    title: "Relay",
    message: `${name} was renamed; the address was left as it was.`,
    variant: "success",
  })
  await refreshStatus(context, client)
}

/** Remove an exit, asking about a Vercel project when there is one. */
async function removeExit(
  context: Context,
  client: RelayClient,
  exit: RelayStatus["exits"][number],
  status: RelayStatus,
): Promise<void> {
  // Only a relay this plugin deployed, and whose account is still stored,
  // has a project that can be deleted from here.
  const hasProject = isDeployedExit(exit, status)
  const sure = await context.ui.dialog.confirm({
    title: `Remove ${exit.name}?`,
    message:
      exit.kind === "relay"
        ? hasProject
          ? "The relay stays deployed on Vercel; only this plugin forgets it. You can ask to delete the project too."
          : "The relay stays deployed on Vercel; only this plugin forgets it."
        : "The proxy is only removed from this plugin.",
    label: { confirm: "Remove it", cancel: "Keep it" },
  })
  if (!sure) return

  if (exit.kind === "relay" && hasProject) {
    const asked = await context.ui.dialog.confirm({
      title: `Delete the Vercel project of ${exit.name} too?`,
      message:
        "The project is what runs the relay, so deleting it stops the relay. Choose no to forget the relay and leave the project running.",
      label: { confirm: "Delete it as well", cancel: "Leave it running" },
    })
    // Escape aborts, the same as it does everywhere else in this menu: the
    // user may have changed their mind about the removal itself.
    if (asked === undefined) {
      context.ui.toast.show({ title: "Relay", message: "Nothing was removed.", variant: "info" })
      return
    }
    const deleteProject = asked
    const result = await withWorking(context, "Removing the relay", () =>
      callRpc(context, "Relay", () => client.removeRelay({ id: exit.id, deleteProject })),
    )
    if (!result) return
    const message = !result.removed
      ? `${exit.name} was not there any more.`
      : !deleteProject
        ? `${exit.name} was removed. Its Vercel project is still running.`
        : result.projectDeleted
          ? `${exit.name} and its Vercel project were removed.`
          : `${exit.name} was removed, but its Vercel project could not be deleted. The status note says why.`
    context.ui.toast.show({
      title: "Relay",
      message,
      variant: !result.removed || (deleteProject && !result.projectDeleted) ? "warning" : "success",
      ...(deleteProject && result.removed && !result.projectDeleted ? { duration: 9000 } : {}),
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
  // A paste that adds nothing is asked about again, with what was pasted
  // already in the box: re-copying a long list is a cost the retry need not
  // have.
  let text: string | undefined
  for (;;) {
    text = await askMultiline(context, {
      title: "Paste your proxy list",
      description: "One proxy per line, any URL form",
      ...(text !== undefined ? { initial: text } : {}),
    })
    if (text === undefined) return
    if (text.trim().length > 0) break
    context.ui.toast.show({ title: "Relay", message: "The list was empty.", variant: "warning" })
  }
  for (;;) {
    const result = await withWorking(context, "Reading the list", () =>
      callRpc(context, "Relay", () => client.addProxies({ text: text as string })),
    )
    if (!result) {
      // The call itself failed. The pasted list is the expensive part, and
      // the retry may be one word away from working, so it is asked for
      // again with what was pasted already in the box.
      const again = await askMultiline(context, {
        title: "Paste your proxy list",
        description: "One proxy per line, any URL form",
        initial: text,
      })
      if (again === undefined) return
      text = again
      continue
    }
    const added = result.added.length
    // One toast says everything, so the summary is not replaced by a second
    // message before it can be read.
    const parts = [`${added} prox${added === 1 ? "y" : "ies"} added`]
    if (result.duplicates > 0) parts.push(`${result.duplicates} already there`)
    if (result.invalid.length > 0) parts.push(`${result.invalid.length} could not be read`)
    // Valid entries that were left out because there were too many: they are
    // not a read failure, and they are said in their own words.
    if (result.leftOut !== undefined) parts.push(result.leftOut)
    if (added > 0) parts.push("the new ones are checked in the background")
    context.ui.toast.show({
      title: "Relay",
      message: parts.join(" - "),
      variant: added > 0 ? "success" : "warning",
      duration: 7000,
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
    await refreshStatus(context, client)
    return
  }
}

/** Start checking every exit without blocking the menu. */
async function startTestAll(context: Context, client: RelayClient, deep: boolean): Promise<void> {
  // The deep test replays a captured request's headers, and the session
  // token is among them: without a capture there is nothing to send. The
  // server has the last word on that, and its refusal is shown.
  const status = currentStatus()
  const hasSample = deep && status?.hasRequestSample === true
  if (deep) {
    // A deep check carries the user's OpenCode session token, so the user is
    // told what it does before it does it to every exit at once. The scan
    // skips paused exits and imported ones: a paused exit was put aside on
    // purpose, and an imported one gets the token only from a test the user
    // asked for by name.
    const sure = await context.ui.dialog.confirm({
      title: "Send a real request through every exit?",
      message: hasSample
        ? "This sends your OpenCode session token through every exit of yours that is not paused, including ones that are used up, cooling down or not tested yet. It is the only check that can tell an address that works from one whose allowance is gone."
        : "No routed request has been captured in the last 30 minutes, so there are no headers to send. Route one request through any exit first, then run this check.",
      label: hasSample
        ? { confirm: "Send them", cancel: "Not now" }
        : { confirm: "Got it", cancel: "Not now" },
    })
    if (!sure) return
    // The capture may have aged out while the dialog was open, or was never
    // there: without headers the call cannot do what the user agreed to. The
    // same warning the single-exit flow gives is shown here, rather than a
    // return that looks like nothing happened; the server's own refusal stays
    // as the backstop.
    if (!hasSample || currentStatus()?.hasRequestSample !== true) {
      context.ui.toast.show({
        title: "Relay",
        message:
          "No routed request has been captured in the last 30 minutes, so there are no headers to send.",
        variant: "warning",
      })
      return
    }
  }
  const result = await callRpc(context, "Relay", () => client.testAll({ deep }))
  if (!result) return
  if (result.refused !== undefined) {
    context.ui.toast.show({
      title: "Relay",
      message: result.refused,
      variant: "warning",
      duration: 9000,
    })
    return
  }
  context.ui.toast.show({
    title: "Relay",
    message:
      result.total === 0
        ? deep
          ? "No exit of yours is unpaused, so there is nothing to send a real request through."
          : "There is no exit to check."
        : result.started
          ? `Checking ${result.total} exit${result.total === 1 ? "" : "s"}${deep ? " with a real model request" : ""} in the background.`
          : "A check is already running.",
    variant: result.started ? "success" : "info",
  })
  // The Exits list refreshes the moment this returns; a refresh here would
  // only ask the server the same question twice.
}

/** Bring every paused exit back into use. */
async function resumeAllPaused(context: Context, client: RelayClient, paused: readonly string[]): Promise<void> {
  if (paused.length === 0) {
    context.ui.toast.show({ title: "Relay", message: "No exit is paused.", variant: "info" })
    return
  }
  const result = await callRpc(context, "Relay", () => client.resumeAllExits({}))
  if (!result) return
  await withWorking(context, "Reading the relay", () => refreshStatus(context, client))
  context.ui.toast.show({
    title: "Relay",
    // Resuming an exit does not make it serve: one whose allowance is gone,
    // or that is resting, stays out of use. The toast says what changed,
    // and not more.
    message:
      result.resumed.length === 0
        ? "No exit was paused after all."
        : `${result.resumed.length} exit${result.resumed.length === 1 ? " is" : "s are"} no longer paused.`,
    variant: result.resumed.length === 0 ? "info" : "success",
  })
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
  // Both ways out show the same exits again, and both have to show their new
  // health: a partial failure leaves the same list it started from.
  await withWorking(context, "Reading the relay", () => refreshStatus(context, client))
  // A relay that was not redeployed is named, not counted away: the user
  // asked for every relay to be updated, and one still running the old code
  // has to be said out loud.
  const skipped = result.skipped ?? []
  if (result.failed.length === 0 && skipped.length === 0) {
    context.ui.toast.show({
      title: "Relay",
      message: `${result.updated} relay${result.updated === 1 ? "" : "s"} updated.`,
      variant: "success",
    })
    return
  }
  await context.ui.dialog.alert({
    title: result.failed.length > 0 ? "Some relays were not updated" : "Some relays were left alone",
    message: [
      `${result.updated} updated, ${result.failed.length} failed, ${skipped.length} left alone.`,
      ...(result.failed.length > 0 ? ["", ...result.failed.map((entry) => `${entry.name}: ${entry.message}`)] : []),
      ...(skipped.length > 0 ? ["", ...skipped.map((entry) => `${entry.name}: ${entry.message}`)] : []),
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
        description: "JSON with the credentials included",
      },
      {
        title: "Import",
        value: "import",
        description: "Vercel accounts are never imported",
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
    description: "The JSON that Export produced",
  })
  if (json === undefined) return
  // Coming back with nothing must say so: a silent return reads as a lost
  // answer, the same way an empty proxy list would.
  if (json.trim().length === 0) {
    context.ui.toast.show({ title: "Relay", message: "Nothing was pasted.", variant: "warning" })
    return
  }
  // The file carries rules as well as exits, and they replace this machine's
  // rules. That is said before it happens, not after.
  const sure = await context.ui.dialog.confirm({
    title: "Replace this machine's rules too?",
    message:
      "The configuration carries the model selection, the strategy, the direct policy and the background checks. Importing it replaces them with the ones in the file.",
    label: { confirm: "Import it", cancel: "Not now" },
  })
  if (!sure) return
  const result = await withWorking(context, "Reading the configuration", () =>
    callRpc(context, "Relay", () => client.importConfig({ json })),
  )
  if (!result) return
  // A file that could not be read at all is said so: "one entry left out"
  // would send the user looking for a bad entry in a file that was never
  // parsed. An import that stopped partway also lands here, but what did
  // land is still counted below, so the two answers stay honest.
  if (result.error !== undefined && result.relays + result.proxies === 0) {
    context.ui.toast.show({
      title: "Relay",
      message: result.error,
      variant: "error",
      duration: 9000,
    })
    await refreshStatus(context, client)
    return
  }
  const parts = [
    `${result.relays} relay${result.relays === 1 ? "" : "s"} and ${result.proxies} prox${result.proxies === 1 ? "y" : "ies"} imported`,
  ]
  if (result.duplicates !== undefined && result.duplicates > 0) parts.push(`${result.duplicates} already there`)
  if (result.invalid > 0) parts.push(`${result.invalid} entr${result.invalid === 1 ? "y" : "ies"} could not be read`)
  // Valid entries that were left out because there were too many: they are
  // not a read failure, and they are said in their own words.
  if (result.leftOut !== undefined) parts.push(result.leftOut)
  if (result.error !== undefined) parts.push(result.error)
  // The imported exits are not tested, so they do not serve yet: saying so is
  // the difference between a working import and a plugin that looks set up
  // and routes nothing.
  if (result.relays + result.proxies > 0) parts.push("test them to use them")
  // The rules came with the file, so the user is told they may have changed.
  // A relay deployed by this plugin arrives as a tracked relay: the Vercel
  // project and the account link do not travel, so its Update action does not
  // either.
  //
  // The rules only went in with a file that went in whole: an import that
  // stopped partway may have failed before they were applied, and saying
  // they are in force then would be wrong.
  if (result.error === undefined) parts.push("any rules in the file are now in force")
  parts.push("relays deployed by this plugin arrive as tracked ones")
  context.ui.toast.show({
    title: "Relay",
    message: parts.join(" - "),
    // An import that stopped partway is a warning, whatever landed: the
    // checkmark would say the configuration went in, and it did not.
    variant:
      result.invalid > 0 ||
      result.leftOut !== undefined ||
      result.error !== undefined ||
      result.relays + result.proxies === 0
        ? "warning"
        : "success",
    duration: 8000,
  })
  await refreshStatus(context, client)
}

/** Deploy a new relay to one region, or several at once. */
async function deployRelay(context: Context, client: RelayClient): Promise<void> {
  // Fresh state: the account list may have changed since the menu opened.
  let refreshed = await withWorking(context, "Reading the relay", () =>
    refreshStatus(context, client),
  )
  let status = refreshed.ok ? refreshed.status : currentStatus()
  if (!status) {
    // Nothing is known about the accounts, so asking to add one would be a
    // guess. The refresh failure is the thing the reader can act on.
    if (!refreshed.ok) reportError(context, "Relay", refreshed.error)
    return
  }
  if (status.accounts.length === 0) {
    // A deploy without an account was a dead end that threw the user out; the
    // way out of the dead end is the thing the deploy needs.
    const add = await context.ui.dialog.confirm({
      title: "No Vercel account yet",
      message: "Deploying a relay needs a Vercel account. Add one now?",
      label: { confirm: "Add an account", cancel: "Not now" },
    })
    if (!add) return
    await addAccount(context, client)
    // The deploy resumes with the account just added instead of dropping the
    // user back at the menu after the detour.
    refreshed = await refreshStatus(context, client)
    status = refreshed.ok ? refreshed.status : currentStatus()
    if (!status || status.accounts.length === 0) return
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
    description: "A label for these relays",
    placeholder:
      regions.length === 1
        ? `Relay in ${regionLabel(regions[0]!)}`
        : "Leave blank for per-region names",
  })
  // Esc backs out of the deploy: a fallback label would deploy something the
  // user just declined to name.
  if (name === undefined) return
  // An empty name is left to the server, which names each region after its
  // own label; one shared placeholder is not a name for several relays.
  const label = name.trim().length > 0 ? name.trim() : undefined

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
      // A relay that answered with a status has a problem of its own - a
      // wrong access token, most of all - and "did not answer" would send
      // the user looking in the wrong place.
      message: deployed.reachable
        ? `${deployed.name} is deployed in ${deployed.regionLabel}: ${deployed.url}`
        : deployed.status !== undefined && deployed.status > 0
          ? `${deployed.name} is deployed in ${deployed.regionLabel}, but it answered HTTP ${deployed.status}: ${deployed.url}`
          : `${deployed.name} is deployed in ${deployed.regionLabel}, but it did not answer yet: ${deployed.url}`,
      variant: deployed.reachable ? "success" : "warning",
      duration: deployed.reachable ? 8000 : 9000,
    })
    await withWorking(context, "Reading the relay", () => refreshStatus(context, client))
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
  // A relay that answered with a status has a problem of its own - a wrong
  // access token, most of all - and "did not answer" would send the user
  // looking in the wrong place.
  const unreachable = deployed.deployed.filter((relay) => !relay.reachable)
  const trouble = unreachable.map((relay) =>
    relay.status !== undefined && relay.status > 0
      ? `${relay.name} answered HTTP ${relay.status}`
      : `${relay.name} did not answer yet`,
  )
  if (deployed.failed.length === 0 && trouble.length === 0) {
    context.ui.toast.show({
      title: "Relay",
      message: `${deployed.deployed.length} relays deployed.`,
      variant: "success",
      duration: 8000,
    })
  } else if (deployed.failed.length > 0) {
    await context.ui.dialog.alert({
      title: "Some regions failed",
      message: [
        `${deployed.deployed.length} deployed, ${deployed.failed.length} failed.`,
        "",
        ...deployed.failed.map((entry) => `${entry.region}: ${entry.message}`),
        ...(trouble.length > 0 ? ["", ...trouble.map((entry) => `${entry}.`)] : []),
      ].join("\n"),
    })
  } else {
    context.ui.toast.show({
      title: "Relay",
      // A deploy that reached the relay but not a working one is not a
      // success, and the toast says what each relay answered.
      message: `${deployed.deployed.length} relays deployed, but ${trouble.join("; ")}.`,
      variant: "warning",
      duration: 9000,
    })
  }
  await withWorking(context, "Reading the relay", () => refreshStatus(context, client))
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
      description: picked.size === 0 ? "Pick at least one region first" : `${picked.size} chosen`,
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
 * Ask a question until it is answered.
 *
 * An empty answer is not an answer. Asking again costs one keystroke, while
 * giving up costs every question that was answered before it, so the flow
 * waits for a real answer instead of ending in an error.
 */
async function askFor(
  context: Context,
  question: { readonly title: string; readonly description?: string; readonly placeholder?: string },
  emptyMessage: string,
): Promise<string | undefined> {
  for (;;) {
    // The plugin may have been reloaded: the question would never be asked.
    if (activationGone(context)) return undefined
    const answer = await context.ui.dialog.prompt(question)
    if (answer === undefined) return undefined
    if (answer.trim().length > 0) return answer.trim()
    context.ui.toast.show({ title: "Relay", message: emptyMessage, variant: "error" })
  }
}

/**
 * Track a relay that already exists.
 *
 * A relay deployed by hand, or by another tool, can be used as it is: the
 * plugin only needs its address and the token it requires.
 */
async function trackRelay(context: Context, client: RelayClient): Promise<void> {
  const name = await askFor(
    context,
    {
      title: "Name this relay",
      description: "A name you will recognize later.",
      placeholder: "my relay",
    },
    "Give the relay a name before tracking it.",
  )
  if (name === undefined) return
  const askedUrl = await askFor(
    context,
    {
      title: "Where does it answer?",
      description: "The relay's https address",
      placeholder: "https://my-relay.vercel.app",
    },
    "Enter the address the relay answers on.",
  )
  if (askedUrl === undefined) return
  let url = askedUrl
  const region = await context.ui.dialog.select<string>({
    title: "Where does it run?",
    options: [
      { title: "I am not sure", value: "", description: "No region label" },
      ...REGIONS.map((item) => ({ title: item.label, value: item.code, description: item.code })),
    ],
  })
  if (region === undefined) return
  const askedAccess = await askFor(
    context,
    {
      title: "Its access token",
      description: "The relay's x-relay-key token",
      placeholder: "access token",
    },
    "Enter the relay's access token.",
  )
  if (askedAccess === undefined) return
  let access = askedAccess
  for (;;) {
    const added = await withWorking(context, `Checking ${name}`, () =>
      callRpc(context, "Relay", () =>
        client.addRelay({
          name,
          url,
          access,
          ...(region.length > 0 ? { region } : {}),
        }),
      ),
    )
    if (added) {
      context.ui.toast.show({
        title: "Relay",
        // A relay that answered with a status has a problem of its own - a
        // wrong access token, most of all - and "did not answer" would send
        // the user looking in the wrong place.
        message: added.reachable
          ? `${added.name} is tracked.`
          : added.status !== undefined && added.status > 0
            ? `${added.name} is tracked, but it answered HTTP ${added.status}.`
            : `${added.name} is tracked but did not answer.`,
        variant: added.reachable ? "success" : "warning",
      })
      await refreshStatus(context, client)
      return
    }
    // The call was refused. The address is the user's own word, and the
    // likeliest refusal is the address itself - an http:// one, or one that
    // carries credentials - so it is asked for again with what was typed
    // already in the box. The token is not shown again: it is a credential,
    // and the relay that was refused it keeps it.
    const nextUrl = await context.ui.dialog.prompt({
      title: "Where does it answer?",
      description: "The relay's https address",
      placeholder: "https://my-relay.vercel.app",
      value: url,
    })
    if (nextUrl === undefined) return
    url = nextUrl.trim()
    const nextAccess = await askFor(
      context,
      {
        title: "Its access token",
        description: "The relay's x-relay-key token",
        placeholder: "access token",
      },
      "Enter the relay's access token.",
    )
    if (nextAccess === undefined) return
    access = nextAccess
  }
}

/** Add a Vercel account, so a relay can be deployed later. */
async function addAccount(context: Context, client: RelayClient): Promise<void> {
  let name = await askFor(
    context,
    {
      title: "Name this account",
      description: "A name for this account",
      placeholder: "personal",
    },
    "Give the account a name before adding it.",
  )
  if (name === undefined) return
  let token = await askFor(
    context,
    {
      title: "Vercel token",
      description: "Vercel Settings -> Tokens",
      placeholder: "vercel token",
    },
    "Paste the Vercel token to add the account.",
  )
  if (token === undefined) return
  for (;;) {
    // The closure below reads the mutable name and token, and TypeScript
    // widens those back to string | undefined inside a closure. The values
    // each attempt sends are captured in a const the loop rebuilds every
    // round, so a retry sends the fresh answers and the types hold.
    const attempt = { name, token }
    const added = await withWorking(context, "Checking the Vercel token", () =>
      callRpc(context, "Relay", () => client.addAccount(attempt)),
    )
    if (added) {
      context.ui.toast.show({
        title: "Relay",
        message: `${added.name} added (${added.plan ?? "plan unknown"}).`,
        variant: "success",
      })
      await refreshStatus(context, client)
      return
    }
    // The call was refused - a token Vercel did not accept, most likely, or
    // a check that could not run. The name is the user's own word, so it is
    // offered again with what was typed already in the box. The token is
    // asked for fresh: it is a credential, and it is never shown again. Both
    // go back into the variables the call reads, or the retry would send the
    // refused answer again.
    const nextName = await context.ui.dialog.prompt({
      title: "Name this account",
      description: "A name for this account",
      placeholder: "personal",
      value: name,
    })
    if (nextName === undefined) return
    name = nextName.trim()
    const nextToken = await askFor(
      context,
      {
        title: "Vercel token",
        description: "Vercel Settings -> Tokens",
        placeholder: "vercel token",
      },
      "Paste the Vercel token to add the account.",
    )
    if (nextToken === undefined) return
    token = nextToken
  }
}

/** Forget an account. The relays deployed with it stay: they run on their own. */
async function removeAccount(context: Context, client: RelayClient, status: RelayStatus): Promise<void> {
  // One account is no choice at all; the confirmation is the only question.
  const only = status.accounts.length === 1 ? status.accounts[0] : undefined
  const choice = only ?? (await context.ui.dialog.select<{ readonly id: string; readonly name: string }>({
    title: "Remove which account?",
    options: status.accounts.map((item) => ({
      title: item.name,
      value: { id: item.id, name: item.name },
      description: item.plan ? `Plan: ${item.plan}` : undefined,
    })),
  }))
  if (choice === undefined) return
  const sure = await context.ui.dialog.confirm({
    title: `Remove ${choice.name}?`,
    message:
      "The relays deployed with this account keep running. The stored token and the name are forgotten, and their Update action is gone for good: the account it needs cannot be linked to them again.",
    label: { confirm: "Remove it", cancel: "Keep it" },
  })
  if (!sure) return
  const result = await callRpc(context, "Relay", () => client.removeAccount({ id: choice.id }))
  if (!result) return
  // A stale id removes nothing; saying it was removed would be a lie.
  context.ui.toast.show({
    title: "Relay",
    message: result.removed ? `${choice.name} removed.` : `${choice.name} was not found.`,
    variant: result.removed ? "success" : "warning",
  })
  await refreshStatus(context, client)
}
