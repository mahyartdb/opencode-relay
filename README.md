# opencode-relay

Route OpenCode's own free models through relays you deploy yourself, so the
daily allowance follows the relay instead of your IP address.
OpenCode's free models are metered per egress address. When you call them
straight from your machine, you spend that day's allowance on your own address,
and everyone sharing your connection spends it with you. This plugin puts a
small relay in front: the request leaves your machine, travels to a relay you
deployed, and the relay calls OpenCode from its own address. Each relay address
has its own allowance, so a few relays in a few regions multiply what you get
out of the free tier.

Only OpenCode's own `opencode` provider is routed. Every other provider and
every other integration is left alone.

## How it works

The plugin hooks OpenCode's HTTP request hook. When a request belongs to a
model you selected, the plugin rewrites it to the active relay and adds the
headers the relay speaks:

- `x-relay-target` - the origin to call, `https://opencode.ai`
- `x-relay-path` - the path and query to call there
- `x-relay-key` - the access token the relay requires
- `x-relay-avoid` - addresses already known to be used up

The relay answers with `x-relay-egress`, the address it sent from. When that
address runs out of allowance, the plugin remembers it and tells the relay to
avoid it, so the next request lands on a different instance with a fresh
address.

One detail makes this work at all: OpenCode Free inspects the TLS handshake of
whoever connects and only accepts a client that presents Bun's cipher suites
in Bun's order. The relay therefore runs on Vercel's Bun runtime, and keeps a
Node fallback that sets the same cipher list by hand.
## Install

Add the plugin to your OpenCode config, `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-relay"]
}
```

OpenCode installs the package on the next start.

To build from a clone instead:

```bash
git clone https://github.com/B3hnamR/opencode-relay.git
cd opencode-relay
bun install
bun run build
```

Then point OpenCode at the folder:

```json
{
  "plugin": ["file:///path/to/opencode-relay"]
}
```

## Use

Type `/relay` in the prompt. The command opens a menu:

- **Turn routing on / off** - routing starts off. Nothing is changed until you
  turn it on.
- **Choose models to route** - route every model, only the free ones, or pick
  them one by one. A model is free when it costs nothing to run, which is what
  puts it on the free allowance.
- **Deploy a relay** - pick a Vercel account and a region. Each relay is its
  own Vercel project running in one region, because a Vercel project on the
  Hobby plan runs in exactly one region.
- **Choose a relay** - switch which relay is active.
- **Add a Vercel account** - you need a Vercel API token with permission to
  create projects. The token is stored on your machine and sent only to
  Vercel.
- **Remove an account / a relay** - removing a relay can also delete its Vercel
  project, so the relay stops running and stops costing anything.
- **Track an existing relay** - use a relay you deployed yourself.
- **Update the active relay** - redeploy the current code over the relay that is
  already running.
- **Test the active relay** - checks that the relay answers and reports the
  address it sends from.

A small pill in the footer shows whether routing is on, which relay is active,
and how many models are routed.
## What it costs

The relays run on Vercel. On the Hobby plan a project runs in one region and
gets 100 deployments a day, which is far more than this plugin needs, since it
deploys only when you ask it to.

## Security

- The relay only forwards to `opencode.ai`. The allowlist is configurable
  through `RELAY_ALLOWED_HOSTS` on the deployed relay, but it does not default
  to an open proxy.
- Each relay has its own access token, stored in the plugin's local storage
  and sent as `x-relay-key`. Requests without it are rejected.
- Vercel API tokens are stored locally and never leave your machine except to
  Vercel.
- The relay strips the headers that describe the caller, so your address and
  location never reach the provider.

## How it is built

- `src/server/` - the server part: the request hook, the stored state, the RPC handlers
  - `index.ts` - the glue: it loads the state, registers the hooks and the RPC
  - `handlers.ts` - one handler per method of the contract
  - `hooks.ts` - the three session hooks and what they need
  - `models.ts` - the provider's models and what they cost
  - `state.ts` - the accounts, the relays and the routing rules
  - `storage.ts` - how that state is written and read back
- `src/tui/` - the terminal part: the `/relay` command, its dialogs, the status pill
- `src/rpc.ts` - the contract the two halves share, typed with Standard Schema
- `src/lib/types.ts` - the shapes both halves agree on
- `src/lib/routing.ts` - which models are routed, and how a request is rewritten
- `src/lib/vercel.ts` - the Vercel API client
- `src/lib/relay-source.ts` - the relay source that gets deployed
- `src/lib/redact.ts` - the one place a secret is taken out of a message
- `relay/relay.js` - the relay itself, deployed to Vercel
- `tools/` - the local relay, so the plugin can be tried without deploying

The plugin ships compiled JavaScript. OpenCode compiles plugin TUI parts with
its own Solid transform, but only outside `node_modules`, so a published
package has to arrive already compiled.

## Development

```bash
bun install
bun test          # the unit tests
bun run typecheck # tsc --noEmit
bun run build     # tsup -> dist/
```

## Credits

The relay template comes from [Polygate](https://github.com/B3hnamR/Polygate),
MIT licensed. See [NOTICE.md](./NOTICE.md) for the full text and the list of
changes.

## Licence

MIT. See [LICENSE](./LICENSE).