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

Models that mirror the same ids under another provider - for example a custom
gateway whose model ids also read `opencode/...` - are not routed even when the
bare id matches. The provider decides, not the name of the model, so select the
model under the `opencode` provider to have it routed.

## Install

The package is distributed from GitHub rather than npm. The installer clones it,
builds it, and adds it to your OpenCode config. `install.sh` is for Linux and
macOS; on Windows, use `install.ps1` instead.

```bash
curl -fsSL https://raw.githubusercontent.com/mahyartdb/opencode-relay/main/install.sh | bash
```

On Windows:

```powershell
irm https://raw.githubusercontent.com/mahyartdb/opencode-relay/main/install.ps1 | iex
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
git clone https://github.com/mahyartdb/opencode-relay.git
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

Type `/relay` in the prompt and press enter, press **alt+r**, or click the
footer pill. The menu stays open after
every action, so one visit can make several changes. Esc or **Close** leaves
it, and Esc inside a submenu returns to the main menu.

### The menu

The actions lead, in the order you reach for them; **Status** and **Preview
the next request** are read-only pages at the bottom, under their own group.
The live state lives on the Status page, in the exits list, and in the footer
pill rather than under each title:

- **Exits** - the exits hub, described below.
- **Add exits** - the three ways to get another address, one step from the main
  menu: deploy a relay, track an existing relay, or paste proxies. Each is
  described below.
- **Models** - route every free model, or choose free models one by one. The
  picker also offers **Select all** and **Clear selection** above the list.
  Paid models are filtered out of the picker and dropped from a custom list:
  the plugin never sends paid traffic through an exit.
- **Test all exits** - shown when there is an exit to scan: a quick scan of
  every exit you added by hand, checking OpenCode through each in the
  background. The deep variant stays on the Exits page, because it needs a
  captured request and sends your session token.
- **Turn routing on / off** - routing starts off. Nothing is changed until you
  turn it on.
- **Settings** - how exits are used, the direct policy, background checks,
  Vercel accounts, and export or import.
- **Status** - a read-only page with everything the plugin knows: routing on
  or off, which models are routed, the strategy and direct policy, background
  checks, the traffic through exits, every exit with its latency and requests,
  the last routing decision, the server's note, and scan progress while a
  background check runs.
- **Preview the next request** - a read-only page that says where the next
  request would go, why, and which exits are being skipped, without sending
  anything or advancing the rotation.

### Routing rules

- **How exits are used** (Settings) - the strategy decides which exit serves a
  request:
  - **One exit** - prefer the chosen exit; if it cannot serve, use the first
    usable one. When nothing is usable, the direct policy decides.
  - **Round robin** - one request per usable exit, in list order.
  - **Until exhausted** - the chosen exit carries every request until it is
    used up, then the next usable exit takes over and becomes the new
    preference.
  - **Fastest** - use the exit with the lowest measured average latency.
    Exits without a measurement go last.
- **When no exit can serve** (Settings) - **Go direct** keeps the session
  working; **Never go direct** fails the request instead. There is no silent
  third option.

A relay or proxy that does not answer is rested: two minutes after the first
failure, doubling with each consecutive failure up to thirty minutes. One
success clears the rest. While every exit is resting, the direct policy applies,
and the menu and pill say so.

### Exits

Relays and proxies are one list because routing treats them the same way: either
can carry a request, and the strategy picks among both.

- **The exits list** - one entry per exit with its state, latency, requests,
  and whether it is chosen; a deployed relay's name already carries its
  region. The batch moves - **Add exits**, **Test all exits**, **Deep test all
  exits**, **Update all relays**, **Bring used-up exits back**, and **Resume
  all paused exits** - sit above the exit rows, so a long list never hides
  them; **Back** is last.
- **Add exits** - **Deploy a relay** (pick a Vercel account and one or more
  regions; each relay is its own Vercel project, and a Hobby project runs in
  one region, so a multi-region setup deploys one relay per region), **Track
  an existing relay** by its URL and access token, or **Add proxies** from a
  pasted list. Deploying with no Vercel account offers to add one instead of
  stopping. A tracked relay needs an `https://` address, because it carries
  the access token; a relay on this machine (`127.0.0.1`, `localhost`) is
  accepted over plain `http://`, since nothing leaves the machine.
- **Exit detail** - open an exit for **Use this exit**, both checks,
  **Pause/Resume**, **Details** (a read-only page with the address, project
  when it has one, health, egress, runtime, request counters, and the last
  error), **Update this relay** (relays this plugin deployed), **Edit its name
  or address** (proxies), and **Remove this exit**.

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
  proves the exit can reach OpenCode without spending a chat completion, and
  it sends no credentials: the model list is answered without a session token.
  It runs on a timer on every exit you added by hand; an imported exit is
  never checked by the timer, because a shared configuration must not be able
  to aim your traffic at an address of its own choosing.
- **Deep test with a real model** - sends a one-token chat request with the
  headers of a captured real request. This is the only check that can tell
  "OpenCode accepts this address" from "this address is used up". It is the
  one that carries your OpenCode session token, so it asks first, and it only
  goes to exits that are not paused: a paused exit was put aside on purpose,
  and used-up, cooling and untested exits all get the token - they are the
  ones the check has to tell apart.
- **Test all exits** (main menu or Exits) - starts the same checks for all
  exits you added by hand in the background; the status page and the pill show
  progress.
- **Deep test all exits** (Exits) - the same, with a real model request
  through each exit that is not paused. It asks first, because it sends your
  OpenCode session token to every one of them.

A 429 that looks like the free usage limit is only a suspicion. The plugin sends
a tiny canary through the same exit; only a canary that is refused too marks the
exit used up. A clean canary means OpenCode refused the request, not the exit,
so the exit is rested briefly instead of retired.

A used-up exit returns at the time OpenCode says (`Retry-After`, capped at 24
hours) or at the next UTC midnight. The state is persisted, so a restart does not
forget it. Only a real model answer through the exit lifts that mark: the model
list is answered even when the allowance is gone, so a background check cannot
clear it.

### Accounts and transfer

Accounts, export, import, and the background checks live in **Settings**:

- **Add a Vercel account** - needs a Vercel API token that can create projects.
  The token is stored on your machine and sent only to Vercel. With exactly one
  account, removing it skips the picker and only asks for confirmation.
- **Remove a Vercel account** - relays it deployed keep running; only the token
  and name are forgotten.
- **Export or import** - writes exits and rules as JSON, credentials included.
  Accounts are never exported or imported. Imported exits are tracked only and
  are not tested: a deep test carries your OpenCode session token, and a
  shared configuration must not be able to aim that at an address of its own
  choosing. Test an imported exit yourself to put it in use.
- **Background checks** - when on, and while routing is on, every exit you
  added by hand is checked every ten minutes, four at a time. An imported
  exit is never checked in the background: test it yourself to put it in
  use. When off, exits are only checked when you ask.

### Keys

| Key | What it does |
| --- | --- |
| alt+r | Open the relay menu from anywhere |
| Up / Down | Move through a list |
| Enter | Choose |
| Esc | Leave the current page, return from a submenu, or leave the menu |
| `t` | Test the exit under the cursor (exits list) |
| `u` | Update the relay under the cursor (exits list; relays this plugin deployed) |
| alt+enter | Confirm a pasted list or configuration |

### The footer pill

One clickable line under the prompt; hovering underlines it and a click opens
the menu. Its text is the honest state, never the number of selected models
dressed up as traffic:

- routing off: `relay off · /relay`, or `relay off · testing 3/8 · /relay`
  while a background check runs
- routing on with no exits: `relay on · no exits · /relay`
- while a background check runs: `relay on · testing 3/8 · <the worst state>`
- a custom selection with nothing free to route: `relay on · nothing routed · /relay`
- no usable exit: `relay on · no exit can serve · direct · /relay` or `· fail · /relay`
- healthy: `relay · Frankfurt · 3 req`, `relay · round robin · 0 req`, with
  `· N used up` and `· N failing` appended when exits are used up or failing.
  Every state that is not healthy carries the `/relay` suffix, and so does a
  healthy-looking line with a used-up or failing exit on it.

The color follows the same state: muted when off, blue while testing, amber
when there is something to look at, red when requests would fail, and the
theme's quiet color when everything is fine.

## Security and privacy

- The local proxy bridge allows only `https://opencode.ai` and its subdomains.
  A relay forwards only to hosts on its `RELAY_ALLOWED_HOSTS` allowlist, which
  defaults to the exact host `opencode.ai` (a wildcard entry requires
  `RELAY_ALLOW_ANY_HOST=1`). The relay and the bridge never follow upstream
  redirects. The OpenCode 2.2.7 host may follow a redirect returned by a
  relay, so only track relays you trust.
- The proxy bridge listens on loopback only and requires a random per-process
  secret. A request without it is rejected.
- The HTTP-to-SOCKS bridge also listens on loopback only, and asks for a secret
  of its own before it opens a tunnel: without it, any process on the machine
  could spend the user's SOCKS credentials. It only ever dials
  `opencode.ai` and its subdomains.
- A relay address has to be `https`, because the access key and the OpenCode
  authorization header travel to it. A relay on this machine (`127.0.0.1`,
  `localhost`) is accepted over plain `http://`, since nothing leaves the
  machine. A relay stored by an older version with a plain `http://` address
  is refused rather than used, so the key cannot travel in the clear.
- A relay has its own access token, sent as `x-relay-key`; requests without it
  are rejected by the relay.
- A relay answers with `x-relay-egress`, the address it sent from. The plugin
  remembers used-up relay addresses and asks relays to avoid them. A proxy has
  one fixed address, so a used-up proxy is retired until it returns. Only an
  address that looks like one is remembered: an exit that reports something
  else cannot put it into the list that every relay receives.
- Vercel API tokens, relay access tokens, and proxy passwords are stored as they
  are, unencrypted, in OpenCode's plugin storage for the local user. No key to
  lose, nothing to recover. Anyone who can read your profile can read them, so
  revoke the Vercel token and redeploy a relay if a machine is lost or shared.
- The TUI never receives a relay token or proxy password, except in Export,
  which is explicitly credential-bearing and opens in a read-only page you can
  scroll and copy from. Otherwise proxy addresses are shown with their
  credentials replaced by `***`. A relay address may not carry credentials at
  all: its token is asked for separately, so an address that carries a
  password is refused rather than stored in the clear.
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
  - `decide.ts` - the one routing decision, shared by the hook and the preview
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
