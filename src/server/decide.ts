/**
 * The one routing decision, shared by the request hook and the preview.
 *
 * Both ends answer the same question - "would this request go through an
 * exit, and why?" - so they must ask it in one place. Two copies of this
 * order would drift, and a preview that disagrees with the hook is worse than
 * no preview at all: the user would plan around an answer the request never
 * takes.
 */
import { PROVIDER_ID, type DirectPolicy, type ExitRecord, type SkippedExit } from "../lib/types.ts"
import { isFree, isSelected, type RoutableModel } from "../lib/routing.ts"
import type { ModelCatalog } from "./models.ts"
import type { RelayState } from "./state.ts"

/** What stopped a request from being routed, or that nothing did. */
export type DecisionKind =
  | "routed"
  | "provider"
  | "off"
  | "catalog"
  | "free"
  | "selection"
  | "no-exit"
  | "bridge"

/** One decision about one model, with everything the caller needs to report it. */
export interface ModelDecision {
  readonly providerID: string
  readonly modelId: string
  readonly kind: DecisionKind
  readonly routed: boolean
  readonly reason: string
  readonly model?: RoutableModel
  readonly exit?: ExitRecord
  readonly skipped: readonly SkippedExit[]
  readonly direct: DirectPolicy
}

/** What the decision needs from the server half. */
export interface DecideDeps {
  readonly state: RelayState
  readonly catalog: ModelCatalog
  readonly bridgeReady: boolean
}

/** What the decision is about. */
export interface DecideInput {
  readonly providerID: string
  readonly modelId: string
  /** True only for a real request: a preview must never move the rotation. */
  readonly advance: boolean
}

/**
 * Decide whether a model goes through an exit, and say why.
 *
 * The order is the contract, and it is not rearrangeable:
 *
 * - The provider check comes first, because only the `opencode` provider is
 *   ever routed. Another provider's model id may look identical and is still
 *   that provider's traffic.
 * - The switch comes next, so a request that arrives while routing is off is
 *   reported as such instead of as a missing exit.
 * - The price and the chosen list are read *before* an exit is picked, so a
 *   paid or unchosen model never advances the rotation. Advancing for a model
 *   that will not be routed would move round robin on for traffic that never
 *   left through it, and the next real request would skip an exit for nothing.
 * - Only then is an exit picked. "No exit can serve" is therefore never the
 *   reason a model that was never going to be routed went direct.
 * - The pick is made without moving the rotation, and the rotation advances
 *   only when the decision is "routed": a request that ends direct or failed
 *   must not spend a turn it never used.
 */
export async function decideModel(
  deps: DecideDeps,
  input: DecideInput,
): Promise<ModelDecision> {
  const { state, catalog, bridgeReady } = deps
  const settings = state.settings()
  const base = {
    providerID: input.providerID,
    modelId: input.modelId,
    skipped: [] as readonly SkippedExit[],
    direct: settings.direct,
  }

  if (input.providerID !== PROVIDER_ID) {
    return {
      ...base,
      kind: "provider",
      routed: false,
      reason: `Only the "${PROVIDER_ID}" provider is routed; this request uses "${input.providerID}".`,
    }
  }

  if (!settings.enabled) {
    return {
      ...base,
      kind: "off",
      routed: false,
      reason: "Routing is off: requests go straight to OpenCode.",
    }
  }

  const models = await catalog.list()
  const model = catalog.resolve(models, input.modelId, settings.selection)

  if (models.length === 0) {
    const failure = catalog.lastFailure()
    return {
      ...base,
      kind: "catalog",
      routed: false,
      model,
      reason:
        failure !== undefined
          ? `The model list could not be read (${failure}), so no model is known to be free.`
          : "The opencode provider lists no model right now.",
    }
  }

  if (!isFree(model)) {
    return {
      ...base,
      kind: "free",
      routed: false,
      model,
      reason: `"${model.name}" is not a free model of the opencode provider.`,
    }
  }

  if (!isSelected(model, settings.selection, settings.customModels)) {
    return {
      ...base,
      kind: "selection",
      routed: false,
      model,
      reason: `"${model.name}" is not in the chosen model list.`,
    }
  }

  // The model qualifies, so the pick may be made -- but the rotation moves
  // only for a decision that actually routes. Picking with `advance: false`
  // first keeps a request that ends at the bridge check or direct from
  // consuming a round-robin turn it never used.
  const pick = state.pickExit({ advance: false })
  const skipped = [...pick.skipped]
  const withModel = { ...base, model, skipped }

  if (pick.exit === undefined) {
    return {
      ...withModel,
      kind: "no-exit",
      routed: false,
      reason:
        settings.direct === "never"
          ? `${pick.reason} Direct routing is not allowed.`
          : pick.reason,
    }
  }

  if (pick.exit.kind === "proxy" && !bridgeReady) {
    return {
      ...withModel,
      kind: "bridge",
      routed: false,
      reason: `The local proxy bridge is not running, so ${pick.exit.name} cannot carry the request.`,
    }
  }

  // The exit will actually carry the request, so this is the only place the
  // rotation advances. The state is unchanged since the first pick, so the
  // second call is deterministic; its answer is the committed truth.
  if (input.advance) {
    const moved = state.pickExit({ advance: true })
    if (moved.exit !== undefined) {
      return {
        ...withModel,
        skipped: [...moved.skipped],
        kind: "routed",
        routed: true,
        exit: moved.exit,
        reason: `The request goes through ${moved.exit.name}.`,
      }
    }
  }

  return {
    ...withModel,
    kind: "routed",
    routed: true,
    exit: pick.exit,
    reason: `The request goes through ${pick.exit.name}.`,
  }
}
