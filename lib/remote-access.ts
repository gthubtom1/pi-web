import { networkInterfaces } from "node:os";

/**
 * Which addresses this machine can be reached at, for the "share to phone" QR
 * codes. Two channels:
 *   - lan:       a private IPv4 on the local network (same Wi-Fi).
 *   - tailscale: a 100.64.0.0/10 address (Tailscale's CGNAT range), reachable
 *                from any device signed into the same tailnet, on any network.
 *
 * Both are IP literals, which the request-security host check already trusts, so
 * these links need no hostname allow-list entry.
 */

export interface RemoteAddress {
  name: string;
  address: string;
}

export interface RemoteAddresses {
  lan: RemoteAddress[];
  tailscale: RemoteAddress[];
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = (value << 8) + n;
  }
  return value >>> 0;
}

/** 100.64.0.0/10 — Tailscale's CGNAT range. */
export function isTailscaleAddress(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return false;
  return value >= ipv4ToInt("100.64.0.0")! && value <= ipv4ToInt("100.127.255.255")!;
}

/** RFC1918 private IPv4 (10/8, 172.16/12, 192.168/16). */
export function isPrivateLanAddress(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return false;
  return (value >= ipv4ToInt("10.0.0.0")! && value <= ipv4ToInt("10.255.255.255")!)
    || (value >= ipv4ToInt("172.16.0.0")! && value <= ipv4ToInt("172.31.255.255")!)
    || (value >= ipv4ToInt("192.168.0.0")! && value <= ipv4ToInt("192.168.255.255")!);
}

/**
 * Adapters a phone cannot reach: hypervisor host-only switches, container bridges,
 * VPN taps and Bluetooth PANs. They still carry a private IPv4 address, so listing
 * them next to the real Wi-Fi/Ethernet address only misleads the QR picker.
 */
const VIRTUAL_INTERFACE = /(vmware|virtualbox|vbox|hyper-?v|vethernet|wsl|docker|loopback|npcap|bluetooth|tap-|tun\d|ppp)/i;

/**
 * Enumerate this machine's shareable addresses, grouped by channel. Loopback,
 * link-local (169.254.x, incl. a tailnet's own 169.254 fallback) and IPv6 are
 * skipped. A Tailscale interface is recognised by its name even before it has a
 * 100.x address, so the phone link appears as soon as Tailscale is installed.
 */
export function listRemoteAddresses(): RemoteAddresses {
  const lan: RemoteAddress[] = [];
  const virtualLan: RemoteAddress[] = [];
  const tailscale: RemoteAddress[] = [];
  const interfaces = networkInterfaces();

  for (const name of Object.keys(interfaces)) {
    const isTailscaleIface = /tailscale|tailnet/i.test(name);
    const isVirtualIface = !isTailscaleIface && VIRTUAL_INTERFACE.test(name);
    for (const info of interfaces[name] ?? []) {
      if (info.family !== "IPv4" || info.internal) continue;
      if (info.address.startsWith("169.254.")) continue;
      if (isTailscaleAddress(info.address)) {
        tailscale.push({ name, address: info.address });
      } else if (isPrivateLanAddress(info.address)) {
        (isVirtualIface ? virtualLan : lan).push({ name, address: info.address });
      } else if (isTailscaleIface) {
        // Tailscale interface without a 100.x address yet: still surface it.
        tailscale.push({ name, address: info.address });
      }
    }
  }

  // Stable, de-duplicated order.
  const dedupe = (list: RemoteAddress[]) => {
    const seen = new Set<string>();
    return list.filter((item) => (seen.has(item.address) ? false : (seen.add(item.address), true)));
  };
  // A machine whose only private addresses are virtual (a Hyper-V-only host, for
  // example) still gets them, so the picker is never empty for no reason.
  return {
    lan: dedupe(lan.length > 0 ? lan : virtualLan),
    tailscale: dedupe(tailscale),
  };
}
