/**
 * The routing state the footer pill and the dialogs both read.
 *
 * One snapshot for the whole plugin: the pill and the menu must never
 * disagree about what is routed, so they read the same signal instead of
 * asking the server twice.
 */
import { createSignal } from "solid-js"
import { Rpc } from "@opencode/plugin/rpc"
import { Relay } from "../rpc.ts"

/** The status shape, taken from the contract so the two ends cannot drift. */
export type RelayStatus = Rpc.Output<typeof Relay.methods.status.output>

/** One model of the provider, as the server reports it. */
export type RelayModel = Rpc.Output<typeof Relay.methods.models.output>["models"][number]

const [status, setStatus] = createSignal<RelayStatus | undefined>(undefined)
const [models, setModels] = createSignal<readonly RelayModel[]>([])

/** The last status the server reported, or undefined when it has not answered yet. */
export function currentStatus(): RelayStatus | undefined {
  return status()
}

/** The models the server knows about, as far as we have looked. */
export function currentModels(): readonly RelayModel[] {
  return models()
}

/** Publish a fresh status; the pill re-renders on this. */
export function publishStatus(next: RelayStatus): void {
  setStatus(next)
}

/** Publish the model list, so the pill can count what is routed. */
export function publishModels(next: readonly RelayModel[]): void {
  setModels(next)
}

/** Forget everything: the plugin is gone and the footer must go quiet. */
export function clearState(): void {
  setStatus(undefined)
  setModels([])
}
