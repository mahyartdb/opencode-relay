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

Type `/relay` in the prompt and press enter, pick "/relay" from the list that
appears when you type a slash, or click the footer pill. The menu stays open
after every action, so a visit can make several changes; Esc or Close leaves it.

### Routing

- **Turn routing on / off** - routing starts off. Nothing is changed until you
  turn it on.
- **Choose models to route** - route every model, only the free ones, or pick
  them one by one. A model is free when it costs nothing to run, which is what
  puts it on the free allowance.
- **Choose how the relays are used** - the strategy decides which relay serves
  a request:
  - **One relay** - every request goes through the chosen relay, even after it
    is marked used up. Nothing moves without you.
  - **Round robin** - one request per relay, in list order, skipping the relays
    whose allowance is gone. When a relay answers 429 it is sidelined, and the
    next request goes to the next usable relay.
  - **Until it is exhausted** - the chosen relay carries every request until it
    reports that its allowance is gone, then the next relay takes over.

A relay that does not answer is skipped for a minute, and the request goes
direct instead. With one relay that means direct until it answers again; with
a rotation the next relay takes the request. The menu and the footer say when
this is happening, so a quiet fallback is never mistaken for a working relay.
Routing can slow a session down or spend the direct allowance, but it does not
take the session down because one relay is unreachable.

### Relays

- **Choose a relay** - switch which relay is chosen.
- **Test a relay** - press `t` in the relay list, or `t` in the main menu to
  test the chosen relay. The answer is a toast with the address the relay used
  and how many milliseconds it took, and the list stays open.
- **Deploy a relay** - pick a Vercel account and a region. Each relay is its
  own Vercel project running in one region, because a Vercel project on the
  Hobby plan runs in exactly one region. With one account the account is used
  without asking.
- **Track an existing relay** - use a relay you deployed yourself, by its
  address and access token.
- **Update the active relay** - redeploy the current code over the relay that is
  already running.
- **Bring the used-up relays back** - a relay sidelined by a 429 stays out until
  you say it may be tried again. This entry puts every such relay back.
- **Remove a relay** - removing a relay can also delete its Vercel project, so
  the relay stops running and stops costing anything.

### Accounts

- **Add a Vercel account** - you need a Vercel API token with permission to
  create projects. The token is stored on your machine and sent only to Vercel.
- **Remove an account** - the relays it deployed keep running; only the token
  and the name are forgotten.

### Keys

| Key | What it does |
| --- | --- |
| Up / Down | Move through a list |
| Enter | Choose |
| `t` | Test the relay (relay list, and the main menu for the chosen relay) |
| Esc | Leave the current page, or the menu |

A small pill in the footer shows whether routing is on, how many relays are
ready, how many models are routed, and how many relays are used up or not
answering. When the chosen relay is not answering, the pill says so and says
that requests go direct. Clicking it opens the same menu.

Routing is off until you turn it on, and turning it off again is one entry in
the menu: "Turn routing off". Requests then go straight to OpenCode, exactly
as they did before the plugin was installed, and no relay is used at all.

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
- `RELAY_ALLOWED_HOSTS` defaults to `opencode.ai`. A wildcard entry makes the
  relay a forwarder for any public host, so it is refused unless
  `RELAY_ALLOW_ANY_HOST=1` is set as well. Only do that if you mean it.
- Tokens are stored as they are, unencrypted, in OpenCode's plugin storage for
  the local user. That is a deliberate trade: no key to lose, nothing to
  recover. Anyone who can read your user profile can read them, so revoke the
  Vercel token and redeploy a relay if a machine is lost or shared.
- The plugin is developed and tested against OpenCode 2.2.7. The package
  declares `@opencode/plugin >=2.2.7 <3`; a newer minor may change the plugin
  API.

## How it is built

- `src/server/` - the server part: the request hook, the stored state, the RPC handlers
  - `index.ts` - the glue: it loads the state, registers the hooks and the RPC
  - `handlers.ts` - one handler per method of the contract
  - `hooks.ts` - the three session hooks and what they need
  - `models.ts` - the provider's models and what they cost
  - `state.ts` - the accounts, the relays and the routing rules
  - `storage.ts` - how that state is written and read back
- `src/tui/` - the terminal part: the `/relay` command, its dialogs, the status pill
  - `dialogs.tsx` - the flows, one conversation per action
  - `present.ts` - the menu entries and the pill line, as pure functions
  - `pill.tsx` - the clickable footer line
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

The package has one server entry (the package root) and one terminal entry
(`./tui`). `./server` is an alias of the root, kept for hosts that ask for a
server entry by name.

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