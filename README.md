# opencode-relay

Route OpenCode's own free models through relays you deploy yourself and proxies
you already own, so the daily allowance follows the exit instead of your IP
address.

OpenCode's free models are metered per egress address. Called straight from your
machine, they spend that day's allowance on your own address, and everyone
sharing your connection spends it with you. This plugin puts an exit in front:
the request leaves your machine, travels through a relay you deployed or a proxy
you added, and reaches OpenCode from that exit's address. Each address has its
own allowance, so a few exits multiply what you get out of the free tier.

Only the `opencode` provider is routed. Every other provider and integration is
left untouched, and only models that cost nothing are ever routed.

## Install

The package is distributed from GitHub rather than npm. The installer clones it,
builds it, and adds it to your OpenCode config. `install.sh` is for Linux and
macOS; on Windows, use `install.ps1` instead.

```bash
curl -fsSL https://raw.githubusercontent.com/B3hnamR/opencode-relay/main/install.sh | bash
```

On Windows:

```powershell
irm https://raw.githubusercontent.com/B3hnamR/opencode-relay/main/install.ps1 | iex
```

Both scripts:

- need [Bun](https://bun.sh) 1.2 or newer;
- install to `~/.local/share/opencode-relay` (`%USERPROFILE%\.local\share\opencode-relay`
  on Windows) unless `OPENCODE_RELAY_HOME` says otherwise;
- build `dist/` and add the folder to the `plugin` array in
  `~/.config/opencode/opencode.json`, keeping a timestamped backup;
- refuse to rewrite a config they cannot parse, and print the snippet to add by
  hand instead.

Pass `--no-config` (or set `OPENCODE_RELAY_NO_CONFIG=1`) to only install and
build. Pass `--update` (or set `OPENCODE_RELAY_UPDATE=1`) to rebuild an existing
installation instead of cloning again.

### Manual install

```bash
git clone https://github.com/B3hnamR/opencode-relay.git
cd opencode-relay
bun install
bun run build
```

Then point OpenCode at the folder in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["file:///absolute/path/to/opencode-relay"]
}
```

Restart OpenCode after changing the config.

## Use

Type `/relay` in the prompt and press enter, pick `/relay` from the slash list,
or click the footer pill. The menu stays open after every action, so one visit
can make several changes. Esc or **Close** leaves it.

### Routing

- **Turn routing on / off** - routing starts off. Nothing is changed until you
  turn it on.
- **Choose models to route** - route every free model, or choose free models one
  by one. Paid models are filtered out of the picker and dropped from a custom
  list: the plugin never sends paid traffic through an exit.
- **Choose how exits are used** - the strategy decides which exit serves a
  request:
  - **One exit** - prefer the chosen exit; if it cannot serve, use the first
    usable one. When nothing is usable, the direct policy decides.
  - **Round robin** - one request per usable exit, in list order.
  - **Until exhausted** - the chosen exit carries every request until it is
    used up, then the next usable exit takes over and becomes the new
    preference.
  - **Fastest** - use the exit with the lowest measured average latency.
    Exits without a measurement go last.
- **When no exit can serve** - **Go direct** keeps the session working;
  **Never go direct** fails the request instead. There is no silent third
  option.
- **Preview the next request** - shows which exit would serve it, why, and which
  exits are being skipped, without sending anything or advancing the rotation.

A relay or proxy that does not answer is rested: two minutes after the first
failure, doubling with each consecutive failure up to thirty minutes. One
success clears the rest. While every exit is resting, the direct policy applies,
and the menu and pill say so.

### Exits

Relays and proxies are one list because routing treats them the same way: either
can carry a request, and the strategy picks among both.

- **Relays and proxies** - list every exit with its kind, region, state, latency,
  and whether it is chosen. Open one to use it, test it, deep-test it, pause or
  resume it, edit it, or remove it.
- **Deploy a relay** - pick a Vercel account and one or more regions. Each relay
  is its own Vercel project. A Hobby project runs in one region, so a
  multi-region setup deploys one relay per region.
- **Track an existing relay** - use a relay you deployed yourself, by its URL and
  access token.
- **Add proxies** - paste a list; see below.
- **Update every relay** - redeploy the current relay code over every relay this
  plugin deployed, keeping URLs and tokens.
- **Bring used-up exits back** - clear the used-up state before its reset time.
  The addresses that were marked as spent stay avoided, so a relay can recycle
  to a fresh instance.
- **Background checks** - turn the automatic health checks on or off. When on,
  and while routing is on, every exit is checked every ten minutes, four at a
  time.

### Proxies

Paste any list your provider gives you. The parser accepts:

- one proxy per line, or several per line separated by commas, semicolons, or
  whitespace;
- `host:port`, `host:port:user:pass`, `host:port@user:pass`,
  `user:pass@host:port`;
- `http://`, `https://`, `socks4://`, `socks4a://`, `socks5://`, `socks5h://`;
- bracketed IPv6 addresses;
- comments (`#` or `//`) and blank lines;
- JSON arrays of objects or strings.

Schemes without one default to HTTP. Duplicates are counted once, whatever
their spelling. Entries that cannot be read are reported with their credentials
removed, so a bad line cannot become a routing entry that fails later in a
harder-to-explain way.

HTTP and HTTPS proxies are used directly by Bun. SOCKS4 and SOCKS5 proxies go
through a loopback HTTP-to-SOCKS bridge started by the plugin on first use.

### Checks

- **Test through OpenCode** - asks the models endpoint through the exit. It
  proves the exit can reach OpenCode without spending a chat completion.
- **Deep test with a real model** - sends a one-token chat request with the
  headers of a captured real request. This is the only check that can tell
  "OpenCode accepts this address" from "this address is used up".
- **Test every exit** - starts the same checks for all exits in the background;
  the menu shows progress.

A 429 that looks like the free usage limit is only a suspicion. The plugin sends
a tiny canary through the same exit; only a canary that is refused too marks the
exit used up. A clean canary means OpenCode refused the request, not the exit,
so the exit is rested briefly instead of retired.

A used-up exit returns at the time OpenCode says (`Retry-After`, capped at 24
hours) or at the next UTC midnight. The state is persisted, so a restart does not
forget it.

### Accounts and transfer

- **Add a Vercel account** - needs a Vercel API token that can create projects.
  The token is stored on your machine and sent only to Vercel.
- **Remove a Vercel account** - relays it deployed keep running; only the token
  and name are forgotten.
- **Export or import** - writes exits and rules as JSON, credentials included.
  Accounts are never exported or imported.

### Keys

| Key | What it does |
| --- | --- |
| Up / Down | Move through a list |
| Enter | Choose |
| Esc | Leave the current page, or the menu |
| `t` | Test all exits (main menu) or the open exit (exit list) |
| `r` | Bring used-up exits back (main menu, when any are used up) |
| alt+enter | Confirm a pasted list or configuration |

The footer pill shows whether routing is on, the chosen exit or strategy, how
many models are routed, and how many exits are used up. When no exit can serve,
it says whether requests go direct or fail. Clicking it opens the same menu.

## Security and privacy

- The local proxy bridge allows only `https://opencode.ai` and its subdomains.
  A relay forwards only to hosts on its `RELAY_ALLOWED_HOSTS` allowlist, which
  defaults to the exact host `opencode.ai` (a wildcard entry requires
  `RELAY_ALLOW_ANY_HOST=1`). Redirects are never followed.
- The proxy bridge listens on loopback only and requires a random per-process
  secret. A request without it is rejected.
- A relay has its own access token, sent as `x-relay-key`; requests without it
  are rejected by the relay.
- A relay answers with `x-relay-egress`, the address it sent from. The plugin
  remembers used-up relay addresses and asks relays to avoid them. A proxy has
  one fixed address, so a used-up proxy is retired until it returns.
- Vercel API tokens, relay access tokens, and proxy passwords are stored as they
  are, unencrypted, in OpenCode's plugin storage for the local user. No key to
  lose, nothing to recover. Anyone who can read your profile can read them, so
  revoke the Vercel token and redeploy a relay if a machine is lost or shared.
- The TUI never receives a relay token or proxy password, except in Export,
  which is explicitly credential-bearing and hands them to the TUI textarea.
  Otherwise proxy addresses are shown with their credentials replaced by `***`.
- The plugin is tested against OpenCode 2.2.7 and declares
  `@opencode/plugin >=2.2.7 <3`.

## What it costs

Relays run on Vercel. A Hobby project runs in one region and gets 100
deployments a day, far more than this plugin needs because it deploys only when
asked. Proxies are whatever you already pay for; the plugin adds no service and
no subscription.

## How it is built

- `src/server/` - the server half
  - `index.ts` - wiring: state, catalog, bridge, tester, handlers, hooks
  - `handlers.ts` - one handler per RPC method
  - `hooks.ts` - request, response, and retry routing
  - `state.ts` - exits, strategies, cooldowns, spent addresses, persistence
  - `storage.ts` - the stored shapes and legacy migration
  - `tester.ts` - ping, API, deep, canary, and the background scan
  - `bridge.ts` - the loopback bridge that lets a proxy carry a request
  - `socks-bridge.ts` - the HTTP-to-SOCKS adapter
  - `models.ts` - the provider's models and what they cost
- `src/tui/` - the terminal half
  - `dialogs.tsx` - every `/relay` flow
  - `present.ts` - menu, exit list, and pill text as pure functions
  - `pill.tsx` - the clickable footer line
- `src/rpc.ts` - the typed contract between the halves
- `src/lib/types.ts` - shared shapes and labels
- `src/lib/routing.ts` - model selection and the exit protocol
- `src/lib/proxy.ts` - the proxy list parser
- `src/lib/vercel.ts` - the Vercel API client
- `src/lib/relay-source.ts` - the relay source that gets deployed
- `src/lib/redact.ts` - the one place a secret is taken out of a message
- `relay/relay.js` - the relay itself, deployed to Vercel
- `tools/` - the local relay and trace stub used by the tests

The plugin ships compiled JavaScript. OpenCode compiles plugin TUI parts with its
own Solid transform, but only outside `node_modules`, so a package has to arrive
already compiled.

The package has one server entry (the package root) and one terminal entry
(`./tui`). `./server` is an alias of the root.

## Development

```bash
bun install
bun test          # unit and integration tests
bun run typecheck # tsc --noEmit
bun run build     # tsup -> dist/
```

## Credits

The relay template and the SOCKS bridge are adapted from
[Polygate](https://github.com/B3hnamR/Polygate), MIT licensed. See
[NOTICE.md](./NOTICE.md) for the full text and the list of changes.

## Licence

MIT. See [LICENSE](./LICENSE).
