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
 */
import { Schema } from "effect"
import { Rpc } from "@opencode/plugin/rpc"

/** Which models are routed through a relay. */
const Selection = Schema.Literals(["all", "free", "custom"])

/** A relay as the TUI sees it. The access token never leaves the server. */
const RelaySummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  project: Schema.String,
  region: Schema.String,
  regionLabel: Schema.String,
  url: Schema.String,
  accountId: Schema.String,
  status: Schema.String,
  createdAt: Schema.Number,
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

export const Relay = Rpc.define({
  id: "opencode-relay",
  methods: {
    /** Current routing state: on or off, the active relay, and what is known. */
    status: {
      // An empty struct rather than Undefined: the call travels as JSON, and a
      // missing key is rejected by the server before the method is even found.
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({
          enabled: Schema.Boolean,
          selection: Selection,
          customModels: Schema.Array(Schema.String),
          activeRelay: Schema.optional(RelaySummary),
          relays: Schema.Array(RelaySummary),
          accounts: Schema.Array(AccountSummary),
          note: Schema.optional(Schema.String),
        }),
      ),
    },

    /** The models of the OpenCode provider, each flagged free and routed. */
    models: {
      // An empty struct rather than Undefined: the call travels as JSON, and a
      // missing key is rejected by the server before the method is even found.
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
          projects: Schema.Number,
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
        invalid_token: Schema.toStandardSchemaV1(
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
    },

    /** Deploy a relay to a region with a stored account. */
    deployRelay: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          accountId: Schema.String,
          name: Schema.optional(Schema.String),
          region: Schema.String,
          runtime: Schema.optional(Schema.Literals(["bun", "node"])),
        }),
      ),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          url: Schema.String,
          region: Schema.String,
          regionLabel: Schema.String,
          reachable: Schema.Boolean,
        }),
      ),
      errors: {
        deploy_failed: Schema.toStandardSchemaV1(
          Schema.Struct({ message: Schema.String }),
        ),
      },
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
      output: Schema.toStandardSchemaV1(
        Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          url: Schema.String,
          region: Schema.String,
          regionLabel: Schema.String,
          reachable: Schema.Boolean,
        }),
      ),
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
        Schema.Struct({ removed: Schema.Boolean }),
      ),
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

    /** Ask a relay whether it answers, and which address it sends from. */
    testRelay: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ id: Schema.String })),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({
          reachable: Schema.Boolean,
          status: Schema.Number,
          egress: Schema.optional(Schema.String),
          runtime: Schema.optional(Schema.String),
        }),
      ),
    },

    /** Switch the active relay. */
    useRelay: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ id: Schema.String })),
      output: Schema.toStandardSchemaV1(Schema.Struct({ active: Schema.String })),
    },

    /** Turn routing on or off. */
    setEnabled: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({ enabled: Schema.Boolean }),
      ),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({ enabled: Schema.Boolean }),
      ),
    },

    /** Choose which models are routed. */
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