/**
 * The models of the OpenCode provider, and what they cost.
 *
 * The price is what tells a free model from a paid one, so the list has to be
 * read before a routing decision can be made. It is read from the server rather
 * than taken from the request, because a request only says which model it is
 * for, not what that model costs.
 */
import type { Context } from "@opencode/plugin/promise/plugin"
import { PROVIDER_ID, type Selection } from "../lib/types.ts"
import type { RoutableModel } from "../lib/routing.ts"

/** How long a list of models is trusted before it is read again. */
export const MODEL_CACHE_MS = 30_000

/** A model as the OpenCode client reports it. */
type ClientModel = Awaited<ReturnType<Context["model"]["list"]>>["data"][number]

/**
 * The provider's models, with the last failure kept.
 *
 * A list that could not be read is not the same as an empty list, and the
 * difference matters: an empty list says "nothing is routed", a failed one says
 * "we do not know". The failure is kept so the note can say so.
 */
export class ModelCatalog {
  private cached: { readonly at: number; readonly models: RoutableModel[] } | undefined
  private failure: string | undefined

  constructor(private readonly context: Context) {}

  /** The message of the last failure, when the list could not be read. */
  lastFailure(): string | undefined {
    return this.failure
  }

  /** The models of the OpenCode provider, as the routing rules understand them. */
  async list(): Promise<RoutableModel[]> {
    const now = Date.now()
    if (this.cached && now - this.cached.at < MODEL_CACHE_MS) return this.cached.models

    let data: ClientModel[]
    try {
      data = (await this.context.model.list()).data
    } catch (err) {
      // Without the list nothing can be told apart, so nothing is claimed.
      this.failure = err instanceof Error ? err.message : String(err)
      return []
    }
    // The list comes from a server that may be busy, so anything that is not a
    // plain list of models is treated as no models at all.
    if (!Array.isArray(data)) {
      this.failure = "the model list was not a list"
      return []
    }

    this.failure = undefined
    const models = data
      .filter((model) => model.providerID === PROVIDER_ID)
      .map((model) => ({
        id: model.modelID,
        name: model.name,
        ...(Array.isArray(model.cost) && model.cost.length > 0
          ? { cost: model.cost.map((tier) => ({ input: tier.input, output: tier.output })) }
          : {}),
      }))
    // An empty list means the server had nothing to say, which is worth asking again.
    if (models.length > 0) this.cached = { at: now, models }
    return models
  }

  /**
   * The model a request is for, in the shape the routing rules understand.
   *
   * The price is only needed to tell a free model from a paid one, so the caller
   * only brings a list when the selection depends on it.
   */
  resolve(models: readonly RoutableModel[], modelId: string, selection: Selection): RoutableModel {
    if (selection !== "free") return { id: modelId, name: modelId }
    const known = models.find((model) => model.id === modelId)
    return known ?? { id: modelId, name: modelId }
  }
}