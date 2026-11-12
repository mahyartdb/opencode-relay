# Notices for opencode-relay

## Polygate relay template

`relay/` contains a modified copy of the relay template published by
[Polygate](https://github.com/B3hnamR/Polygate) (`relays/vercel-bun/api/relay.js`
and `relays/vercel-bun/vercel.json`).

Polygate is licensed under the MIT License:

```
MIT License

Copyright (c) 2026 B3hnamR

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Changes made in this repository:

- The Bun cipher list and the Node fallback cipher list are unchanged: OpenCode
  Free only accepts a client whose TLS handshake presents Bun's cipher suites
  in Bun's order, so that behaviour is load-bearing and was preserved verbatim.
- The relay environment variable was renamed from `POLYGATE_RELAY_TOKEN` to
  `RELAY_TOKEN`, and the host allowlist from `POLYGATE_ALLOWED_HOSTS` to
  `RELAY_ALLOWED_HOSTS`.
- The `x-relay-*` request and response headers are unchanged, so a relay
  deployed by Polygate and a relay deployed by this plugin are interchangeable.
- The relay no longer forwards to arbitrary hosts by default: `RELAY_ALLOWED_HOSTS`
  defaults to `opencode.ai`, and the `x-relay-target` header must name a host
  on that list.
