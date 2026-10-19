# Remote access: password, phone pairing, public tunnel

## The password (`lib/web-secret.ts`, `bin/pi-web.js`)

- **The local browser never signs in.** `proxy.ts` treats a loopback `Host`
  (`127.0.0.0/8`, `localhost`, `::1`) as the person at the keyboard and skips auth
  (`isLoopbackHostHeader()`, lib/request-security.ts). The CLI opens exactly that
  URL — Next's own `Network: http://0.0.0.0:…` line is not browsable (browsers
  refuse it; through a proxy it answers 502), which is why `pi-web` used to look
  broken while it was running fine.
- Everything else — LAN, Tailscale, the tunnel — needs the password. Precedence:
  `PI_WEB_PASSWORD` non-empty → that password; `PI_WEB_PASSWORD` empty → remote auth
  off; otherwise `<agentDir>/pi-web-auth.json` says whether a password is required
  (Settings › Remote access switch, default on, corrupt file → on) and a random
  32-char secret is generated once into `<agentDir>/pi-web-secret` (mode 0600). There
  is deliberately **no password in the source**.
- The switch exists because Windows cannot set an empty environment variable
  (`set X=` deletes it), so "empty `PI_WEB_PASSWORD` disables auth" only works on
  POSIX. Turning it off opens the port to every device that can reach it.
- **The loopback exemption trusts `Host`, which a browser cannot forge but a script
  can.** On an untrusted network, bind loopback only (`--hostname 127.0.0.1`) and
  reach the phone through the tunnel or Tailscale; the tunnel still works because
  cloudflared connects to 127.0.0.1 and its hostname is not loopback, so it needs
  the password.
- `bin/pi-web.js` resolves the same secret before opening the browser and prints it
  at startup as the *remote* password, next to "On this machine (no password
  needed)".
- **Settings › Remote access manages it live**: `reveal-password` returns the stored
  value (never an env-supplied one), `set-password` writes a chosen one (>= 6 chars,
  and it turns remote auth back on), `randomize-password` stores a fresh 32-char
  one. The stored secret is read on every request, so a change applies immediately.
- **The QR and the copied link carry the password**: `<origin>/?pw=<password>`, and
  `/login` redeems it exactly like the form (`app/login/page.tsx`). That is the DSH
  behaviour - the link is the key, the phone types nothing. The one-time 2-minute
  `?pair=` code stays for a borrowed phone. A copied link *is* a credential: do not
  post it anywhere public.
- Turning the switch off does not dead-end the panel: the QR/one-time code need a
  password (the tunnel too - it would otherwise expose the agent to the internet),
  so the tunnel row offers "Create a password and start" instead of refusing.

## Phone pairing (`lib/pairing.ts`, `POST /api/web-auth/pair`, `app/login/page.tsx`)

- Settings › Remote access issues a token `<expiresAtMs>.<hmac>` signed with the current password
  (2 min TTL). It carries no password, is single-use per process (in-memory set, so a restart allows
  reuse within the TTL), and a forged/expired/reused token is a 401.
- The QR URL is `<origin>/?pair=<token>`; `/login` redeems it once (`pairAttemptedRef` survives React
  StrictMode's double effect) and replaces the location with `safeDestination()`. `proxy.ts` lets
  `/api/web-auth/pair` through unauthenticated — that is the point of pairing.
- The cookie's `secure` flag follows `x-forwarded-proto`, which a Cloudflare tunnel sends as `https`.

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
