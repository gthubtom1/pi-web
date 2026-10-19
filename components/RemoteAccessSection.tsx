"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton, ConfigNotice, ConfigSwitch } from "./SettingsUi";
import { QrCode } from "./QrCode";

interface RemoteAddress { name: string; address: string }
interface TunnelState {
  status: "stopped" | "starting" | "running" | "error";
  url: string | null;
  hostname: string | null;
  error: string | null;
  startedAt: number | null;
  phase: "idle" | "downloading" | "connecting";
  usingSystemBinary: boolean;
  binaryInstalled: boolean;
}
interface RemoteInfo {
  port: number;
  lan: RemoteAddress[];
  tailscale: RemoteAddress[];
  tunnel: TunnelState;
  passwordEnabled: boolean;
  authRequired: boolean;
  authSource: "env" | "env-disabled" | "generated" | "disabled";
  secretPath: string;
}

type Channel = { key: string; kind: "lan" | "tailscale" | "tunnel"; label: string; url: string };

/**
 * Settings › Remote access.
 *
 * The password is for **other devices only** (this machine's browser is let in by
 * the proxy). It is shown here, can be replaced or randomized, and the QR/link
 * carries it so a phone opens straight into the app — the DSH behaviour: copy the
 * link, scan the code, done. The one-time code stays available for a phone you do
 * not want to keep a password for.
 */
export function RemoteAccessSection() {
  const { t } = useI18n();
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [channelKey, setChannelKey] = useState<string | null>(null);
  const [pair, setPair] = useState<{ url: string; expiresAt: number } | null>(null);
  const [remotePassword, setRemotePassword] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [showCustom, setShowCustom] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/remote");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setInfo(await res.json() as RemoteInfo);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const reveal = useCallback(async () => {
    try {
      const res = await fetch("/api/remote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reveal-password" }),
      });
      if (!res.ok) return;
      const json = await res.json() as { password: string | null };
      setRemotePassword(json.password);
    } catch {
      // the panel still works without it
    }
  }, []);

  useEffect(() => {
    void load();
    void reveal();
    // Poll while the tunnel is starting so the URL appears when it is ready.
    const timer = setInterval(() => {
      setInfo((current) => {
        if (current?.tunnel.status === "starting") void load();
        return current;
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [load, reveal]);

  // Build the selectable channels from the addresses and tunnel state.
  const channels: Channel[] = [];
  if (info) {
    for (const a of info.lan) channels.push({ key: `lan:${a.address}`, kind: "lan", label: `${t("remote.lan")} · ${a.address}`, url: `http://${a.address}:${info.port}/` });
    for (const a of info.tailscale) channels.push({ key: `ts:${a.address}`, kind: "tailscale", label: `${t("remote.tailscale")} · ${a.address}`, url: `http://${a.address}:${info.port}/` });
    if (info.tunnel.status === "running" && info.tunnel.url) channels.push({ key: "tunnel", kind: "tunnel", label: `${t("remote.public")} · ${info.tunnel.hostname}`, url: `${info.tunnel.url}/` });
  }
  const active = channels.find((c) => c.key === channelKey) ?? channels[0] ?? null;
  const loginUrl = active && remotePassword ? `${active.url}?pw=${encodeURIComponent(remotePassword)}` : null;

  const post = async (body: Record<string, unknown>) => {
    const res = await fetch("/api/remote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
    return json as Record<string, unknown>;
  };

  const generatePair = async (target: { url: string }) => {
    setBusy("pair");
    setError(null);
    setPair(null);
    try {
      const json = await post({ action: "pair" });
      setPair({ url: `${target.url}?pair=${String(json.token)}`, expiresAt: Number(json.expiresAt) });
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  };

  const tunnelAction = async (action: "tunnel-start" | "tunnel-stop" | "tunnel-uninstall") => {
    setBusy(action);
    setError(null);
    setPair(null);
    try {
      const json = await post({ action });
      if (action === "tunnel-uninstall" && (json.tunnel as TunnelState | undefined)?.binaryInstalled !== false) {
        setError(t("remote.tunnelUninstallFailed"));
      }
      await load();
      if (action === "tunnel-start") await autoPairTunnel();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  };

  // A public tunnel without a password would hand the agent to the internet, so the
  // button makes one first instead of refusing with a dead end.
  const startTunnelWithPassword = async () => {
    setBusy("tunnel-start");
    setError(null);
    try {
      const json = await post({ action: "randomize-password" });
      setRemotePassword(String(json.password));
      setRevealed(true);
      await load();
      await tunnelAction("tunnel-start");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  };

  const autoPairTunnel = async () => {
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      let next: RemoteInfo | null = null;
      try {
        const res = await fetch("/api/remote");
        if (res.ok) next = await res.json() as RemoteInfo;
      } catch { /* keep polling */ }
      if (next) setInfo(next);
      if (next?.tunnel.status === "running" && next.tunnel.url) {
        setChannelKey("tunnel");
        return;
      }
      if (next?.tunnel.status === "error") return;
    }
  };

  const setPasswordRequired = async (required: boolean) => {
    setBusy("auth");
    setError(null);
    setPair(null);
    try {
      await post({ action: "set-password-required", required });
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  };

  const randomize = async () => {
    setBusy("password");
    setError(null);
    try {
      const json = await post({ action: "randomize-password" });
      setRemotePassword(String(json.password));
      setRevealed(true);
      setShowCustom(false);
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  };

  const saveCustom = async () => {
    setBusy("password");
    setError(null);
    try {
      const json = await post({ action: "set-password", password: draft });
      setRemotePassword(String(json.password));
      setRevealed(true);
      setShowCustom(false);
      setDraft("");
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  };

  const copyText = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied((current) => (current === key ? null : current)), 1500);
    } catch {
      setError(t("remote.copyFailed"));
    }
  };

  const rowStyle: React.CSSProperties = {
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16,
    padding: "14px 0", borderBottom: "1px solid var(--border)",
  };
  const labelStyle: React.CSSProperties = { fontSize: 13, fontWeight: 500, color: "var(--text)" };
  const hintStyle: React.CSSProperties = { fontSize: 12, color: "var(--text-muted)", marginTop: 3, maxWidth: 520, lineHeight: 1.5 };
  const selectStyle: React.CSSProperties = {
    height: 32, padding: "0 10px", fontSize: 13, borderRadius: 6,
    border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", minWidth: 220, maxWidth: 320,
  };
  const monoStyle: React.CSSProperties = {
    fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text)",
    padding: "4px 8px", borderRadius: 6, background: "var(--bg-panel)",
    overflowWrap: "anywhere", userSelect: "all",
  };

  const tunnel = info?.tunnel;
  const localUrl = info ? `http://127.0.0.1:${info.port}/` : "";
  const tunnelStatusText = !tunnel ? ""
    : tunnel.status === "running" ? t("remote.tunnelRunning")
    : tunnel.status === "starting" && tunnel.phase === "downloading" ? t("remote.tunnelDownloading")
    : tunnel.status === "starting" ? t("remote.tunnelStarting")
    : tunnel.status === "error" ? t("remote.tunnelError")
    : t("remote.tunnelStopped");
  const authLockedByEnv = info?.authSource === "env" || info?.authSource === "env-disabled";
  const shownPassword = authLockedByEnv ? null : remotePassword;

  return (
    <div className="settings-general">
      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("remote.heading")}</h3>
        <p className="settings-general-description">{t("remote.description")}</p>

        {error ? <p role="alert" className="settings-general-error">{t("remote.failed")}{error}</p> : null}

        {!info ? (
          <p style={hintStyle}>{t("remote.loading")}</p>
        ) : (
          <>
            {/* This machine: no password, ever. */}
            <div style={rowStyle}>
              <div style={{ minWidth: 0 }}>
                <div style={labelStyle}>{t("remote.localLabel")}</div>
                <div style={hintStyle}>{t("remote.localHint")}</div>
                <div style={{ ...monoStyle, marginTop: 6, display: "inline-block" }}>{localUrl}</div>
              </div>
              <ConfigButton variant="ghost" size="small" onClick={() => void copyText(localUrl, "local")}>
                {copied === "local" ? t("remote.copied") : t("remote.copy")}
              </ConfigButton>
            </div>

            {/* Remote password: shown, replaceable, or off. */}
            <div style={{ ...rowStyle, alignItems: "flex-start" }}>
              <div style={{ minWidth: 0 }}>
                <div style={labelStyle}>{t("remote.passwordLabel")}</div>
                <div style={hintStyle}>{authLockedByEnv ? t("remote.authLockedByEnv") : t("remote.passwordHint")}</div>
                {!authLockedByEnv && shownPassword ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                    <span style={monoStyle}>{revealed ? shownPassword : "•".repeat(Math.min(shownPassword.length, 24))}</span>
                    <ConfigButton variant="ghost" size="small" onClick={() => setRevealed((v) => !v)}>
                      {revealed ? t("remote.hide") : t("remote.show")}
                    </ConfigButton>
                    <ConfigButton variant="ghost" size="small" onClick={() => void copyText(shownPassword, "password")}>
                      {copied === "password" ? t("remote.copied") : t("remote.copy")}
                    </ConfigButton>
                    <ConfigButton variant="secondary" size="small" onClick={() => void randomize()} disabled={busy !== null}>
                      {t("remote.randomize")}
                    </ConfigButton>
                    <ConfigButton variant="ghost" size="small" onClick={() => setShowCustom((v) => !v)} disabled={busy !== null}>
                      {t("remote.custom")}
                    </ConfigButton>
                  </div>
                ) : null}
                {!authLockedByEnv && showCustom ? (
                  <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                    <input
                      type="text"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder={t("remote.customPlaceholder")}
                      style={{ ...selectStyle, minWidth: 200 }}
                      onKeyDown={(e) => { if (e.key === "Enter") void saveCustom(); }}
                    />
                    <ConfigButton variant="primary" size="small" onClick={() => void saveCustom()} disabled={busy !== null || draft.trim().length < 6}>
                      {t("remote.savePassword")}
                    </ConfigButton>
                  </div>
                ) : null}
              </div>
              <ConfigSwitch
                checked={info.authRequired}
                disabled={authLockedByEnv || busy !== null}
                label={t("remote.authLabel")}
                onChange={(next) => void setPasswordRequired(next)}
              />
            </div>
            {info.authSource === "disabled" ? <ConfigNotice>{t("remote.authOffNotice")}</ConfigNotice> : null}

            {/* Channel + QR/link that carries the password. */}
            <div style={rowStyle}>
              <div>
                <div style={labelStyle}>{t("remote.channelLabel")}</div>
                <div style={hintStyle}>{t("remote.channelHint")}</div>
              </div>
              {channels.length > 0 ? (
                <select
                  style={selectStyle}
                  value={active?.key ?? ""}
                  onChange={(e) => { setChannelKey(e.target.value); setPair(null); }}
                >
                  {channels.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
              ) : (
                <span style={{ ...hintStyle, marginTop: 0 }}>{t("remote.noChannel")}</span>
              )}
            </div>

            <div style={{ ...rowStyle, alignItems: "flex-start" }}>
              <div style={{ minWidth: 0 }}>
                <div style={labelStyle}>{t("remote.shareLabel")}</div>
                <div style={hintStyle}>{t("remote.shareHint")}</div>
                {active ? (
                  <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                    <ConfigButton
                      variant="primary"
                      size="small"
                      onClick={() => loginUrl && void copyText(loginUrl, "link")}
                      disabled={!loginUrl}
                    >
                      {copied === "link" ? t("remote.copied") : t("remote.copyLink")}
                    </ConfigButton>
                    <ConfigButton variant="ghost" size="small" onClick={() => void generatePair(active)} disabled={busy === "pair" || !info.passwordEnabled}>
                      {busy === "pair" ? t("remote.generating") : t("remote.tempCode")}
                    </ConfigButton>
                  </div>
                ) : null}
                {!info.passwordEnabled ? (
                  <p style={{ ...hintStyle, color: "var(--accent)" }}>{t("remote.pairNeedsPassword")}</p>
                ) : null}
                {pair ? (
                  <div style={{ marginTop: 10, display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                    <QrCode value={pair.url} size={150} />
                    <div style={{ maxWidth: 260 }}>
                      <code style={{ fontSize: 11, color: "var(--text-muted)", overflowWrap: "anywhere" }}>{pair.url}</code>
                      <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>{t("remote.expiresIn")}</div>
                    </div>
                  </div>
                ) : null}
              </div>
              {loginUrl ? (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, flexShrink: 0 }}>
                  <QrCode value={loginUrl} size={170} />
                  <span style={{ fontSize: 11, color: "var(--text-dim)", maxWidth: 180, textAlign: "center" }}>{t("remote.qrHint")}</span>
                </div>
              ) : null}
            </div>

            {/* Public tunnel. */}
            <div style={{ ...rowStyle, borderBottom: "none" }}>
              <div style={{ minWidth: 0 }}>
                <div style={labelStyle}>{t("remote.tunnelLabel")}</div>
                <div style={hintStyle}>{t("remote.tunnelHint")}</div>
                <div style={{ ...hintStyle, marginTop: 6, color: "var(--text)" }}>{tunnelStatusText}</div>
                {tunnel?.binaryInstalled ? <div style={hintStyle}>{t("remote.tunnelInstalled")}</div> : null}
                {tunnel?.status === "running" && tunnel.url ? (
                  <div style={{ fontSize: 12, marginTop: 4, overflowWrap: "anywhere" }}><code>{tunnel.url}</code></div>
                ) : null}
                {tunnel?.status === "error" && tunnel.error ? (
                  <p role="alert" style={{ ...hintStyle, color: "#ef4444" }}>{tunnel.error}</p>
                ) : null}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, flexShrink: 0 }}>
                {tunnel?.status === "running" || tunnel?.status === "starting" ? (
                  <ConfigButton variant="secondary" size="small" onClick={() => void tunnelAction("tunnel-stop")} disabled={busy !== null}>
                    {busy === "tunnel-stop" ? t("remote.stopping") : t("remote.tunnelStop")}
                  </ConfigButton>
                ) : !info.passwordEnabled ? (
                  // No password yet: make one, then open the tunnel — a public tunnel
                  // without a password would expose the agent to the whole internet.
                  <ConfigButton variant="secondary" size="small" onClick={() => void startTunnelWithPassword()} disabled={busy !== null || authLockedByEnv}>
                    {busy === "tunnel-start" ? t("remote.starting") : t("remote.tunnelStartWithPassword")}
                  </ConfigButton>
                ) : (
                  <ConfigButton variant="secondary" size="small" onClick={() => void tunnelAction("tunnel-start")} disabled={busy !== null}>
                    {busy === "tunnel-start" ? t("remote.starting") : t("remote.tunnelStart")}
                  </ConfigButton>
                )}
                <ConfigButton
                  variant="ghost"
                  size="small"
                  onClick={() => void tunnelAction("tunnel-uninstall")}
                  disabled={busy !== null || (!tunnel?.binaryInstalled && tunnel?.status === "stopped")}
                >
                  {busy === "tunnel-uninstall" ? t("remote.uninstalling") : t("remote.tunnelUninstall")}
                </ConfigButton>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
