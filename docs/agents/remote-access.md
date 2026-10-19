# Remote access: password, phone pairing, public tunnel

## Pairing, per entry (`lib/remote-pairing.ts`)

Three doors, three credentials, and `scopeForHost()` is what decides which one a request used: the
tunnel's own hostname → `public`, a 100.64/10 (tailnet) address → `tailscale`, anything else →
`lan`. The tailnet getting its own scope is deliberate — a device on the tailnet must not need the
code of the house's Wi-Fi, and revoking one door must not touch the others. A pairing file written
before that scope existed is migrated once on read (the generated tailscale credential is written
back; otherwise every read would hand out a different code).

- Local access needs nothing: a loopback `Host` (`127.0.0.0/8`, `localhost`, `::1` —
  `isLoopbackHostHeader()`) skips auth, and the CLI opens exactly that URL (Next's
  `Network: http://0.0.0.0:…` line is a bind address; browsers refuse it and a proxy
  answers 502).
- Every other device pairs with a **short code**, one per entry: **lan** (same Wi-Fi)
  and **public** (the tunnel). Each scope stores `{ enabled, code, secret }` in
  `<agentDir>/pi-web-remote-pairing.json`, plaintext on purpose — the panel re-reads
  the code after a restart (ToDesk-style). Codes are 8 characters from a
  confusion-reduced alphabet (no I/L/O/0/1), or a custom 6-12 A-Z0-9; the secret is
  24 random bytes for the QR. Both redeem the same credential.
- `scopeForHost()` picks the scope from the Host: the tunnel's own hostname (from
  `lib/dynamic-hosts.ts`) is `public`, anything else is `lan`. A LAN code therefore
  never opens the public entry (tested), and the switches are independent.
- **The QR carries the secret in the URL fragment**: `<origin>/#pair=<secret>`. The
  fragment never reaches the server, a log or a Referer; the login page reads it,
  posts it to `/api/web-auth/pair`, and strips it from the address bar afterwards. A
  scanned device types nothing. `?pair=` is still honoured for old links.
- `POST /api/web-auth` accepts `{ code }` (typed) or `{ password }` — the latter only
  when `PI_WEB_PASSWORD` pins an operator password. Codes share **one** throttle
  (`lib/auth-throttle.ts`): behind a tunnel every request arrives from cloudflared on
  127.0.0.1, so a per-source lock would let a stranger lock the owner out.
- The session cookie is signed with `getWebAuthKey()`: the operator password when set,
  otherwise a random key generated once in `<agentDir>/pi-web-session-key` (so a
  paired phone stays paired across restarts). The old generated "password" is no
  longer an auth decision — that was the confusion where the first run was a login
  wall.
- A scope with `enabled: false` needs no code at all. The public one refuses to be
  silently open: starting the tunnel turns it on, and the panel warns when it is off.
- `tunnel-check` fetches `<tunnel-url>/api/web-auth` from the server, so the whole
  public path (DNS -> Cloudflare edge -> cloudflared -> app) is tested on demand; a
  DNS failure names `*.trycloudflare.com` explicitly, because a phone on the same
  resolver will fail the same way.

### The panel: three cards, three QRs (`components/RemoteAccessSection.tsx`)

With three doors open at once, "which code belongs to which QR" has to be answerable at a glance, so the
panel renders three numbered CARDS (border, header row, body | QR) instead of one long column of
sections: every card repeats the same order — number, name, what it is (`remote.tag*`), the pairing
switch with its caption, then 配对码 → 地址 → its QR. Each card's QR occupies the same fixed square
(`QR_SLOT`) even when that door has no address yet; the empty square is a dashed placeholder with a
one-line reason (`remote.qrEmpty*`), which keeps the three cards aligned instead of letting the page
jump as a tunnel starts or stops. The public card carries the rest below a divider (status and its
buttons, autoStart, tunnel mode and the fixed-domain form).

## Public tunnel (`lib/tunnel.ts`, `lib/dynamic-hosts.ts`, `app/api/remote/route.ts`)

- A Cloudflare **quick tunnel** (`cloudflared tunnel --url http://127.0.0.1:<port>`) exposes a random
  `https://<name>.trycloudflare.com`. Outbound only, no account. Refused unless a password is enabled:
  it exposes an agent that runs commands.
- `cloudflared` is looked up on `PATH`, else downloaded into `<agentDir>/pi-web-bin` through
  `resolveOutboundProxy()` (env proxies first, then a TCP probe of the usual local 梯子 ports), and the
  child process gets the same proxy in `HTTPS_PROXY`/`ALL_PROXY`.
- The download is written to a `.partial-<pid>` file and renamed into place only when it is complete
  (10-minute timeout: 55 MB through a residential proxy took 184 s here). A failed or aborted transfer
  therefore leaves nothing behind — the earlier direct write left a truncated executable that every
  later start reused. `phase: "downloading" | "connecting"` lets the panel say what is happening.
  **Uninstall** stops the tunnel and deletes the downloaded binary, retrying the delete (Windows keeps
  the just-killed image locked; a single `rmSync` reported success while leaving 53 MB behind).
  `binaryInstalled` reports the real result, and the panel warns when it is still there.
- **China caveat:** cloudflared connects out through the proxy and gets a hostname, but a phone must be
  able to resolve `*.trycloudflare.com`. On this machine that lookup failed (`ENOTFOUND`) even while
  the tunnel was up, so "tunnel running" is not proof the phone can open it; the QR/password path over
  LAN or Tailscale does not depend on that DNS.

- `tunnel-check` (the panel's "Test it") fetches the public address from this machine, so a success
  proves the whole path (DNS, edge, connector, app) and a failure names the step that broke. A 403 whose
  body is a Cloudflare error page, or a 15 s timeout, means the *zone* is wrong — see the DNS note at the
  end of this file.
- Lifecycle lives on `globalThis` (survives hot reload). `startTunnel()` returns at once; the panel polls
  `/api/remote`. The exact hostname is registered with `lib/dynamic-hosts.ts` only while the tunnel is
  up, so request security trusts that one host and not a `trycloudflare.com` wildcard.

## Two modes: quick tunnel or fixed domain (`lib/tunnel-config.ts`)

- `mode` in `<agentDir>/pi-web-tunnel.json` (0600, `version: 1`, `{ mode, token, hostname, autoStart }`)
  chooses one or the other. The file is the only place the credential lives: nothing is hard-coded,
  nothing is derived from an environment variable, and `GET /api/remote` answers `hasToken` — never the
  token itself. A blank token box in Settings therefore means "keep the saved one", and the panel has no
  way to leak it.
- Fixed domain: `cloudflared tunnel --no-autoupdate run` with the token in `TUNNEL_TOKEN`, deliberately
  **not** on the command line (a token in `argv` shows up in `ps` and in every crash banner), and never
  in a log line. `cloudflared` prints no URL in this mode, so readiness comes from its
  `Registered tunnel connection` line, with a 20 s "still alive, assume ready" fallback; the public
  address is `https://<hostname>` from the config. On Windows the 0600 request is advisory: the file
  lives in the user's own agent dir, and Windows has no POSIX mode.
- The hostname is validated (`lib/tunnel-config-view.ts`): one exact DNS name, lower case, no wildcard,
  no scheme/port/path, no IP literal, no `localhost`. That one name — never a zone — is what
  `lib/dynamic-hosts.ts` trusts while the tunnel is up, and a save that changes it removes the old one.
- Writes are explicit and confirmed: `tunnel-config-save` / `tunnel-config-clear` answer
  `409 { needsConfirm: true }` when the save would replace a credential or move a live tunnel's public
  address, and the panel asks first (`remote.namedSaveConfirm`). A save restarts a running tunnel in the
  new mode, so the address the panel shows is the one that works; the old one is unregistered at once.
- **Keepalive (B1):** a tunnel that was *running* and then exited is restarted with exponential backoff
  (1 s doubling to 30 s, `restarts` in the state), keeping the address the phone is already on. A tunnel
  that never came up stays in `error` — a broken credential must not spin forever. `stopTunnel()` clears
  the intent, so a stop is never undone by the keepalive, and `installTunnelShutdownHook()` kills the
  child when the server exits.
- **autoStart (B2):** off by default. When on, `instrumentation-node.ts` starts the tunnel at boot
  (`PI_WEB_PORT`, which `bin/pi-web.js` passes to the server) in the saved mode. Turning it on without a
  credential reports an error in the panel instead of retrying at every boot.
- The panel shows the **current address** with a Copy button and says not to use the browser history
  (B3): after a restart or a hostname change the old address is dead.
- Reminder for the Cloudflare side: a named tunnel's public hostname is a **CNAME to
  `<tunnel-id>.cfargotunnel.com`** (proxied), and its ingress route points at `http://127.0.0.1:<port>`.
  An `A` record to a LAN IP there yields Cloudflare ``error 1000`` ("DNS points to prohibited IP"),
  which looks like "the tunnel is down" from the phone while the connector is perfectly healthy.

## What the pairing code protects, and how hard it is to guess

- A wrong **code** feeds `lib/auth-throttle.ts` (exponential backoff, 1 s doubling to 60 s) in a bucket
  of its own (`getPairingRetryAfterMs` / `recordPairingFailure`), so a phone with a stale code cannot
  lock the operator out of the password form and vice versa. The endpoint answers `429` with
  `Retry-After` while blocked. **The QR's `secret` is not throttled**: it is 24 random bytes, so a block
  there would only punish the phone that just scanned.
- The default code is 8 characters from a 31-letter alphabet (~8.5e11). A hand-typed 6-character code is
  ~2.2e9, which is why the backoff exists at all — and why a memorable code (`888888`) is a bad idea.
- Measured before the fix: 40 wrong codes in 109 ms, all `401`, no `429`.

## Credential files are not browsable (`lib/file-access.ts`)

`isCredentialFile()` refuses `<agentDir>/pi-web-tunnel.json`, `pi-web-remote-pairing.json`,
`pi-web-auth.json`, `pi-web-session-key` and pi's own `auth.json`, in both the lexical and the
symlink-resolving check behind `/api/files`.

Why it matters: the allowed roots are the sessions' **cwds**, so a session opened in the home directory
puts the whole agent dir in reach. Measured before the fix: a paired phone on the public hostname could
`GET /api/files/.../&#8203;.pi/agent/pi-web-tunnel.json?type=read` and receive the named tunnel's token,
while `/api/remote` carefully answers only `hasToken`. A paired device already has the terminal and the
agent, so this was never an escalation — but it defeated the reason the token is stored behind
`hasToken` in the first place.

## LAN / Tailscale addresses (`lib/remote-access.ts`)

- `listRemoteAddresses()` reports RFC1918 LAN and Tailscale 100.64/10 addresses. Hypervisor/container/
  VPN-tap adapters (VMware, VirtualBox, Hyper-V `vEthernet`, WSL, docker, `tap-`/`tun`, bluetooth) are
  dropped — a phone cannot reach a host-only switch — but kept as a fallback when they are all a
  machine has, so the picker is never empty for no reason.
- Both channels are IP literals, which `isApiRequestAllowed()` already trusts; only the tunnel hostname
  needs the dynamic allow-list.
