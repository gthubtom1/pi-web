/**
 * Hostnames trusted in addition to the static config, registered at runtime.
 *
 * The tunnel manager adds the exact `*.trycloudflare.com` hostname it is serving
 * while a tunnel is up, and removes it when the tunnel stops. Request security
 * consults this set, so a tunnel opens only its own hostname — not a blanket
 * `*.trycloudflare.com` wildcard that would weaken DNS-rebinding protection.
 *
 * Kept on globalThis so it survives Next.js hot reload in development.
 */

declare global {
  var __piWebDynamicHosts: Set<string> | undefined;
}

function store(): Set<string> {
  return (globalThis.__piWebDynamicHosts ??= new Set<string>());
}

export function addDynamicHost(host: string): void {
  const normalized = host.trim().toLowerCase();
  if (normalized) store().add(normalized);
}

export function removeDynamicHost(host: string): void {
  store().delete(host.trim().toLowerCase());
}

export function getDynamicHosts(): string[] {
  return [...store()];
}
