/**
 * The contract between the server part and the TUI part.
 *
 * The TUI part runs in the terminal UI, the server part in the OpenCode
 * server, so they talk over this RPC. The server registers it in `setup`, and
 * the TUI calls it through `context.client.rpc(Relay)`.
 *
 * Every schema is a Standard Schema, so the same definition types both ends:
 * the TUI knows what a method returns, and the server validates what it is
 * given before the handler ever sees it.
 *
 * Only `exportConfig` carries credentials: it is the one method whose whole
 * job is to write them out, and the terminal says so before it shows it.
 * Every other answer stays credential-free - a relay's access token and a
 * proxy's password never cross this contract. A handler that would break that
 * has to say so here, in the schema, where a reader looks for it.
 */
import { Schema } from "effect"
import { Rpc } from "@opencode/plugin/rpc"

/** Which models are routed through an exit. Only free models are ever used. */
const Selection = Schema.Literals(["free", "custom"])

/** How the exits are used. */
const Strategy = Schema.Literals(["fixed", "round-robin", "exhausted", "fastest"])

/** What happens when no exit can serve a request. */
const Direct = Schema.Literals(["allow", "never"])

/** Counters kept for one exit since the process started. */
const ExitStats = Schema.Struct({
  requests: Schema.Number,
  ok: Schema.Number,
  rotated: Schema.Number,
  limited: Schema.Number,
  failed: Schema.Number,
  lastMs: Schema.optional(Schema.Number),
  averageMs: Schema.optional(Schema.Number),
})

/** A relay or a proxy as the TUI sees it. Credentials are stripped. */
const ExitSummary = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["relay", "proxy"]),
  name: Schema.String,
  status: Schema.String,
  statusLabel: Schema.String,
  enabled: Schema.Boolean,
  /** A relay's public URL, or a proxy's address with its credentials removed. */
  url: Schema.String,
  createdAt: Schema.Number,
  project: Schema.optional(Schema.String),
  region: Schema.optional(Schema.String),
  regionLabel: Schema.optional(Schema.String),
  accountId: Schema.optional(Schema.String),
  egress: Schema.optional(Schema.String),
  runtime: Schema.optional(Schema.String),
  latencyMs: Schema.optional(Schema.Number),
  lastCheck: Schema.optional(Schema.Number),
  exhaustedUntil: Schema.optional(Schema.Number),
  /** Why OpenCode said the address is used up, when it said. */
  spendReason: Schema.optional(Schema.String),
  lastError: Schema.optional(Schema.String),
  stats: ExitStats,
})

/** A Vercel account as the TUI sees it. The token never leaves the server. */
const AccountSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  plan: Schema.optional(Schema.String),
  teamId: Schema.optional(Schema.String),
  createdAt: Schema.Number,
})

/** A model of the OpenCode provider, with the free flag and the routed flag. */
const ModelSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  free: Schema.Boolean,
  routed: Schema.Boolean,
})

/** Why one exit was skipped, for the preview page. */
const SkippedExit = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["relay", "proxy"]),
  reason: Schema.String,
})

/** The last routing decision, so the user can see why a request went direct. */
const LastDecision = Schema.Struct({
  at: Schema.Number,
  modelId: Schema.String,
  routed: Schema.Boolean,
  reason: Schema.String,
  exitId: Schema.optional(Schema.String),
  exitName: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.Literals(["relay", "proxy"])),
})

/** How far a background test run has got. */
const ScanProgress = Schema.Struct({
  startedAt: Schema.Number,
  total: Schema.Number,
  done: Schema.Number,
  deep: Schema.Boolean,
})

/**
 * A change that could not be written.
 *
 * The change is in memory but not on disk, so the caller is told instead of
 * being answered as if the change had been saved.
 */
const StorageFailed = Schema.toStandardSchemaV1(Schema.Struct({ message: Schema.String }))

/** What the plugin is doing right now. */
const Status = Schema.Struct({
  enabled: Schema.Boolean,
  selection: Selection,
  strategy: Strategy,
  direct: Direct,
  /** Whether exits are checked automatically in the background. */
  healthChecks: Schema.Boolean,
  customModels: Schema.Array(Schema.String),
  activeExit: Schema.optional(ExitSummary),
  exits: Schema.Array(ExitSummary),
  accounts: Schema.Array(AccountSummary),
  exhausted: Schema.Array(Schema.String),
  paused: Schema.Array(Schema.String),
  /**
   * Exits that are resting right now.
   *
   * A rest is armed by a failure, a rate limit or a refusal: the exit did
   * answer, and it is out of use until the rest is over. The exits that are
   * out of use for another reason are in `exhausted` and `paused`.
   */
  skipped: Schema.Array(Schema.String),
  /**
   * The exit the picker would use for the next request, with the live cooldown
   * state applied. Absent when no exit can serve, and from a server that
   * predates the field.
   */
  servingExitId: Schema.optional(Schema.String),
  /** The exits the picker would leave out, with the live cooldown state applied. */
  skippedExitIds: Schema.optional(Schema.Array(Schema.String)),
  scanning: Schema.optional(ScanProgress),
  lastDecision: Schema.optional(LastDecision),
  note: Schema.optional(Schema.String),
  /** How many free models the current selection routes. */
  routedCount: Schema.Number,
  /** How many OpenCode models are known, free or not. */
  modelCount: Schema.Number,
})

/** What a routing preview says, without sending or advancing anything. */
const RoutePreview = Schema.Struct({
  modelId: Schema.optional(Schema.String),
  /** The provider the model belongs to, when one was named. */
  providerID: Schema.optional(Schema.String),
  routed: Schema.Boolean,
  reason: Schema.String,
  direct: Direct,
  exit: Schema.optional(ExitSummary),
  skipped: Schema.Array(SkippedExit),
})

/** One proxy that was added from a pasted list. */
const AddedProxy = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** The address without credentials. */
  url: Schema.String,
  status: Schema.String,
})

/** A relay that was just deployed. */
const DeployedRelay = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  url: Schema.String,
  region: Schema.String,
  regionLabel: Schema.String,
  reachable: Schema.Boolean,
})

export const Relay = Rpc.define({
  id: "opencode-relay",
  methods: {
    /** Current routing state: on or off, the exits, and what is known. */
    status: {
      // An empty struct rather than Undefined: the call travels as JSON, and a
      // missing key is rejected by the server before the method is even found.
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(Status),
    },

    /** The models of the OpenCode provider, each flagged free and routed. */
    models: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({ models: Schema.Array(ModelSummary) }),
      ),
    },

    /** Add a Vercel account after checking the token and reading its plan. */
    addAccount: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          name: Schema.String,
          token: Schema.String,
          teamId: Schema.optional(Schema.String),
        }),
      ),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          plan: Schema.optional(Schema.String),
          team: Schema.optional(Schema.String),
          teams: Schema.Number,
          projectsSampled: Schema.Number,
          projectsMore: Schema.Boolean,
          limits: Schema.optional(
            Schema.Struct({
              regionsPerProject: Schema.Number,
              deploymentsPerDay: Schema.Number,
              projects: Schema.optional(Schema.Number),
            }),
          ),
        }),
      ),
      errors: {
        storage_failed: StorageFailed,
        invalid_token: Schema.toStandardSchemaV1(
          Schema.Struct({ message: Schema.String }),
        ),
        /** Vercel could not be reached; the token may well be fine. */
        vercel_unreachable: Schema.toStandardSchemaV1(
          Schema.Struct({ message: Schema.String }),
        ),
      },
    },

    /** Remove a stored account. Relays deployed with it are kept. */
    removeAccount: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ id: Schema.String })),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({ removed: Schema.Boolean }),
      ),
      errors: {
        storage_failed: StorageFailed,
      },
    },

    /** Deploy a relay to one region with a stored account. */
    deployRelay: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          accountId: Schema.String,
          name: Schema.optional(Schema.String),
          region: Schema.String,
          runtime: Schema.optional(Schema.Literals(["bun", "node"])),
        }),
      ),
      output: Schema.toStandardSchemaV1(DeployedRelay),
      errors: {
        storage_failed: StorageFailed,
        deploy_failed: Schema.toStandardSchemaV1(
          Schema.Struct({ message: Schema.String }),
        ),
      },
    },

    /** Deploy the same relay to several regions in one conversation. */
    deployRelays: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          accountId: Schema.String,
          name: Schema.optional(Schema.String),
          regions: Schema.Array(Schema.String),
          runtime: Schema.optional(Schema.Literals(["bun", "node"])),
        }),
      ),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({
          deployed: Schema.Array(DeployedRelay),
          failed: Schema.Array(
            Schema.Struct({ region: Schema.String, message: Schema.String }),
          ),
        }),
      ),
    },

    /** Track a relay that already exists somewhere else. */
    addRelay: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          name: Schema.String,
          url: Schema.String,
          access: Schema.String,
          region: Schema.optional(Schema.String),
        }),
      ),
      output: Schema.toStandardSchemaV1(DeployedRelay),
      errors: {
        storage_failed: StorageFailed,
        insecure_relay: Schema.toStandardSchemaV1(Schema.Struct({ message: Schema.String })),
      },
    },

    /** Remove a relay, and optionally delete its Vercel project. */
    removeRelay: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          id: Schema.String,
          deleteProject: Schema.optional(Schema.Boolean),
        }),
      ),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({
          removed: Schema.Boolean,
          /** True when the project was asked for and Vercel confirmed it is gone. */
          projectDeleted: Schema.Boolean,
        }),
      ),
      errors: {
        storage_failed: StorageFailed,
      },
    },

    /** Remove any exit, whichever kind it is. The Vercel project is kept. */
    removeExit: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ id: Schema.String })),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({ removed: Schema.Boolean }),
      ),
      errors: {
        storage_failed: StorageFailed,
      },
    },

    /** Redeploy the current relay code, keeping the URL and access token. */
    updateRelay: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ id: Schema.String })),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({ id: Schema.String, reachable: Schema.Boolean }),
      ),
      errors: {
        update_failed: Schema.toStandardSchemaV1(
          Schema.Struct({ message: Schema.String }),
        ),
      },
    },

    /** Redeploy every relay that this plugin deployed. */
    updateAllRelays: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({
          updated: Schema.Number,
          failed: Schema.Array(
            Schema.Struct({ id: Schema.String, name: Schema.String, message: Schema.String }),
          ),
          /** Relays that were not redeployed, and why. */
          skipped: Schema.Array(
            Schema.Struct({ id: Schema.String, name: Schema.String, message: Schema.String }),
          ),
        }),
      ),
    },

    /** Test one exit: an OpenCode request, or a tiny real model request. */
    testExit: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          id: Schema.String,
          deep: Schema.optional(Schema.Boolean),
        }),
      ),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({
          ok: Schema.Boolean,
          status: Schema.String,
          /** The HTTP status, or 0 when no answer arrived. */
          code: Schema.Number,
          ms: Schema.Number,
          egress: Schema.optional(Schema.String),
          runtime: Schema.optional(Schema.String),
          note: Schema.optional(Schema.String),
        }),
      ),
      errors: {
        storage_failed: StorageFailed,
      },
    },

    /** Start checking every exit in the background. */
    testAll: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({ deep: Schema.optional(Schema.Boolean) }),
      ),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({ total: Schema.Number, started: Schema.Boolean }),
      ),
    },

    /** Switch the exit the one-exit and until-exhausted strategies prefer. */
    useExit: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ id: Schema.String })),
      output: Schema.toStandardSchemaV1(Schema.Struct({ active: Schema.String })),
      errors: {
        storage_failed: StorageFailed,
        unknown_exit: Schema.toStandardSchemaV1(Schema.Struct({ message: Schema.String })),
      },
    },

    /** Pause an exit, or bring it back. */
    setExitEnabled: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({ id: Schema.String, enabled: Schema.Boolean }),
      ),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({ id: Schema.String, enabled: Schema.Boolean }),
      ),
      errors: {
        storage_failed: StorageFailed,
        unknown_exit: Schema.toStandardSchemaV1(Schema.Struct({ message: Schema.String })),
      },
    },

    /** Bring every paused exit back into use. */
    resumeAllExits: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({ resumed: Schema.Array(Schema.String) }),
      ),
      errors: {
        storage_failed: StorageFailed,
      },
    },

    /** Add every proxy that can be read from a pasted list. */
    addProxies: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          text: Schema.String,
          /** A prefix for the names; the host is appended. */
          name: Schema.optional(Schema.String),
        }),
      ),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({
          added: Schema.Array(AddedProxy),
          /** Entries that could not be read, with their credentials removed. */
          invalid: Schema.Array(
            Schema.Struct({ value: Schema.String, reason: Schema.String }),
          ),
          duplicates: Schema.Number,
          /** Valid entries that were left out because there were too many. */
          leftOut: Schema.optional(Schema.String),
        }),
      ),
      errors: {
        storage_failed: StorageFailed,
      },
    },

    /** Change a proxy's name or address. A new address is tested afresh. */
    updateProxy: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          id: Schema.String,
          name: Schema.optional(Schema.String),
          url: Schema.optional(Schema.String),
        }),
      ),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({
          updated: Schema.Boolean,
          /** Why nothing was changed, when nothing was. */
          reason: Schema.optional(Schema.String),
        }),
      ),
      errors: {
        storage_failed: StorageFailed,
      },
    },

    /** Turn routing on or off. */
    setEnabled: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ enabled: Schema.Boolean })),
      output: Schema.toStandardSchemaV1(Schema.Struct({ enabled: Schema.Boolean })),
      errors: {
        storage_failed: StorageFailed,
      },
    },

    /** Choose which models are routed. Only free models are accepted. */
    setSelection: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          selection: Selection,
          models: Schema.optional(Schema.Array(Schema.String)),
        }),
      ),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({
          selection: Schema.String,
          customModels: Schema.Array(Schema.String),
          /** Ids that were left out because they are not free. */
          dropped: Schema.Array(Schema.String),
        }),
      ),
      errors: {
        storage_failed: StorageFailed,
      },
    },

    /** Choose how the exits are used. */
    setStrategy: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ strategy: Strategy })),
      output: Schema.toStandardSchemaV1(Schema.Struct({ strategy: Strategy })),
      errors: {
        storage_failed: StorageFailed,
      },
    },

    /** Choose what happens when no exit can serve a request. */
    setDirect: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ direct: Direct })),
      output: Schema.toStandardSchemaV1(Schema.Struct({ direct: Direct })),
      errors: {
        storage_failed: StorageFailed,
      },
    },

    /** Whether the exits are checked in the background. */
    setHealthChecks: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({ enabled: Schema.Boolean }),
      ),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({ enabled: Schema.Boolean }),
      ),
      errors: {
        storage_failed: StorageFailed,
      },
    },

    /** Bring the exits whose allowance is gone back into use. */
    resetExhausted: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({ restored: Schema.Array(Schema.String) }),
      ),
      errors: {
        storage_failed: StorageFailed,
      },
    },

    /** Show where the next request would go, without sending or advancing anything. */
    preview: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          modelId: Schema.optional(Schema.String),
          /** The provider the model belongs to; only `opencode` is routed. */
          providerID: Schema.optional(Schema.String),
        }),
      ),
      output: Schema.toStandardSchemaV1(RoutePreview),
    },

    /** Write the exits and the rules out as JSON. Credentials are included. */
    exportConfig: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(Schema.Struct({ json: Schema.String })),
    },

    /** Read exits and rules back in. Accounts are never imported. */
    importConfig: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ json: Schema.String })),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({
          relays: Schema.Number,
          proxies: Schema.Number,
          invalid: Schema.Number,
          /** Entries that were already there, counted so "nothing new" is visible. */
          duplicates: Schema.optional(Schema.Number),
          /** Why the file could not be read, or why the import stopped partway. */
          error: Schema.optional(Schema.String),
          /** Valid entries that were left out because there were too many. */
          leftOut: Schema.optional(Schema.String),
        }),
      ),
    },
  },
  events: {
    /** Emitted when routing state changes, so the TUI can refresh. */
    changed: {
      schema: Schema.toStandardSchemaV1(
        Schema.Struct({ reason: Schema.String }),
      ),
    },
    /**
     * Emitted when the command is run, so the TUI can open its menu.
     *
     * The command itself lives on the server, because that is where the list of
     * commands the prompt offers comes from. The menu is a dialog, and a dialog
     * can only be opened by the terminal.
     */
    menu: {
      schema: Schema.toStandardSchemaV1(Schema.Struct({})),
    },
  },
})

export type RelayRpc = typeof Relay
