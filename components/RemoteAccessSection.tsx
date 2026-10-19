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
 * Settings › Remote access: how a phone reaches this machine, the one-time QR
 * pairing code, the public tunnel, and whether a password is required at all.
 */
export function RemoteAccessSection() {
  const { t } = useI18n();
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [channelKey, setChannelKey] = useState<string | null>(null);
  const [pair, setPair] = useState<{ url: string; expiresAt: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/remote");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setInfo(await res.json() as RemoteInfo);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    // Poll while the tunnel is starting so the URL appears when it is ready.
    const timer = setInterval(() => {
      setInfo((current) => {
        if (current?.tunnel.status === "starting") void load();
        return current;
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [load]);

  // Build the selectable channels from the addresses and tunnel state.
  const channels: Channel[] = [];
  if (info) {
    for (const a of info.lan) channels.push({ key: `lan:${a.address}`, kind: "lan", label: `${t("remote.lan")} · ${a.address}`, url: `http://${a.address}:${info.port}/` });
    for (const a of info.tailscale) channels.push({ key: `ts:${a.address}`, kind: "tailscale", label: `${t("remote.tailscale")} · ${a.address}`, url: `http://${a.address}:${info.port}/` });
    if (info.tunnel.status === "running" && info.tunnel.url) channels.push({ key: "tunnel", kind: "tunnel", label: `${t("remote.public")} · ${info.tunnel.hostname}`, url: `${info.tunnel.url}/` });
  }
  const active = channels.find((c) => c.key === channelKey) ?? channels[0] ?? null;

  const generatePair = async (target: { url: string }) => {
    setBusy("pair");
    setError(null);
    setPair(null);
    try {
      const res = await fetch("/api/remote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pair" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      setPair({ url: `${target.url}?pair=${json.token}`, expiresAt: json.expiresAt });
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
      const res = await fetch("/api/remote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      // The delete is retried server-side; if the binary is still there, say so
      // rather than reporting a clean uninstall that left 53 MB behind.
      if (action === "tunnel-uninstall" && json?.tunnel?.binaryInstalled !== false) {
        setError(t("remote.tunnelUninstallFailed"));
      }
      const started = action === "tunnel-start";
      await load();
      // Starting a public tunnel should land on a scannable QR with no extra
      // click: wait for the URL, then generate the pairing code for it.
      if (started) await autoPairTunnel();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  };

  // Poll the tunnel until it is running, then produce its pairing QR automatically.
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
        await generatePair({ url: `${next.tunnel.url}/` });
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
      const res = await fetch("/api/remote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-password-required", required }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
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

  const tunnel = info?.tunnel;
  const tunnelStatusText = !tunnel ? ""
    : tunnel.status === "running" ? t("remote.tunnelRunning")
    // The first start downloads ~50 MB through the machine's proxy; say so instead
    // of showing a bare "Starting…" for minutes.
    : tunnel.status === "starting" && tunnel.phase === "downloading" ? t("remote.tunnelDownloading")
    : tunnel.status === "starting" ? t("remote.tunnelStarting")
    : tunnel.status === "error" ? t("remote.tunnelError")
    : t("remote.tunnelStopped");
  const authLockedByEnv = info?.authSource === "env" || info?.authSource === "env-disabled";

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
            {/* Password switch */}
            <div style={rowStyle}>
              <div style={{ minWidth: 0 }}>
                <div style={labelStyle}>{t("remote.authLabel")}</div>
                <div style={hintStyle}>
                  {authLockedByEnv ? t("remote.authLockedByEnv") : t("remote.authHint")}
                </div>
                {info.authSource === "generated" || info.authSource === "disabled" ? (
                  <div style={{ ...hintStyle, fontFamily: "var(--font-mono)", marginTop: 4, overflowWrap: "anywhere" }}>
                    {info.secretPath}
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
            {info.authSource === "disabled" ? (
              <ConfigNotice>{t("remote.authOffNotice")}</ConfigNotice>
            ) : null}

            {/* Channel picker + QR */}
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
                  <div style={{ marginTop: 10 }}>
                    <ConfigButton
                      variant="primary"
                      size="small"
                      onClick={() => void generatePair(active)}
                      disabled={busy === "pair" || !info.passwordEnabled}
                    >
                      {busy === "pair" ? t("remote.generating") : t("remote.generate")}
                    </ConfigButton>
                    {!info.passwordEnabled ? (
                      <p style={{ ...hintStyle, color: "var(--accent)" }}>{t("remote.needPassword")}</p>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {pair ? (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, flexShrink: 0 }}>
                  <QrCode value={pair.url} size={180} />
                  <code style={{ fontSize: 11, color: "var(--text-muted)", maxWidth: 220, overflowWrap: "anywhere", textAlign: "center" }}>{pair.url}</code>
                  <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("remote.expiresIn")}</span>
                </div>
              ) : null}
            </div>

            {/* Public tunnel management */}
            <div style={{ ...rowStyle, borderBottom: "none" }}>
              <div style={{ minWidth: 0 }}>
                <div style={labelStyle}>{t("remote.tunnelLabel")}</div>
                <div style={hintStyle}>{t("remote.tunnelHint")}</div>
                <div style={{ ...hintStyle, marginTop: 6, color: "var(--text)" }}>{tunnelStatusText}</div>
                {tunnel?.binaryInstalled ? (
                  <div style={hintStyle}>{t("remote.tunnelInstalled")}</div>
                ) : null}
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
                ) : (
                  <ConfigButton variant="secondary" size="small" onClick={() => void tunnelAction("tunnel-start")} disabled={busy !== null || !info.passwordEnabled}>
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

            {!info.passwordEnabled ? (
              <ConfigNotice>{t("remote.passwordNotice")}</ConfigNotice>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
