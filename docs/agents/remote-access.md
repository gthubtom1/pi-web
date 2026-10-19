# Remote access: password, phone pairing, public tunnel

## Pairing, per entry (`lib/remote-pairing.ts`)

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
- Lifecycle lives on `globalThis` (survives hot reload). `startTunnel()` returns at once; the panel polls
  `/api/remote`. The exact hostname is registered with `lib/dynamic-hosts.ts` only while the tunnel is
  up, so request security trusts that one host and not a `trycloudflare.com` wildcard.
- Not started automatically on boot, deliberately: a public URL that appears without a click is a
  surprise, and this product's decision is that the tunnel only exists while the user turns it on.

## LAN / Tailscale addresses (`lib/remote-access.ts`)

- `listRemoteAddresses()` reports RFC1918 LAN and Tailscale 100.64/10 addresses. Hypervisor/container/
  VPN-tap adapters (VMware, VirtualBox, Hyper-V `vEthernet`, WSL, docker, `tap-`/`tun`, bluetooth) are
  dropped — a phone cannot reach a host-only switch — but kept as a fallback when they are all a
  machine has, so the picker is never empty for no reason.
- Both channels are IP literals, which `isApiRequestAllowed()` already trusts; only the tunnel hostname
  needs the dynamic allow-list.
