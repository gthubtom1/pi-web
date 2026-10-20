"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
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
  restarts: number;
  restarting: boolean;
  autoStart: boolean;
}
/** The tunnel's own settings. A quick tunnel has no token or hostname to hold. */
interface TunnelConfigInfo {
  autoStart: boolean;
  path: string;
}
interface PairingScope { enabled: boolean; code: string; secret: string }
interface RemoteInfo {
  port: number;
  lan: RemoteAddress[];
  tailscale: RemoteAddress[];
  tunnel: TunnelState;
  tunnelConfig: TunnelConfigInfo;
  pairing: { lan: PairingScope; public: PairingScope; tailscale: PairingScope };
  passwordEnabled: boolean;
  authSource: "env" | "env-disabled" | "generated" | "disabled";
}
type Scope = "lan" | "public" | "tailscale";
interface CheckResult {
  ok: boolean;
  status?: number;
  ms?: number;
  error?: string;
  dnsFailure?: boolean;
}

/** Every card's QR slot is the same square, filled or not, so the three line up. */
const QR_SLOT = 156;

/**
 * Settings › Remote access.
 *
 * Three doors for other devices — the local network, the tailnet, and the public
 * tunnel — each with its own credential, its own address and its own QR. They are
 * rendered as three numbered CARDS, not as sections of one long column: with three
 * QRs on screen, "which code belongs to which door" has to be answerable at a
 * glance, so every card repeats the same layout (number, name, what it is, its
 * code, its address, its QR) and its QR always occupies the same square, empty or
 * not, so the cards stay aligned even before an address exists.
 *
 * This machine itself needs no code: 127.0.0.1 is always let in.
 */
export function RemoteAccessSection() {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [editing, setEditing] = useState<Scope | null>(null);
  const [draft, setDraft] = useState("");
  const [check, setCheck] = useState<CheckResult | null>(null);

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
    const timer = setInterval(() => {
      setInfo((current) => {
        if (current?.tunnel.status === "starting" || current?.tunnel.restarting) void load();
        return current;
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [load]);

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

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
      await load();
    }
  };

  const applyTunnelState = (json: Record<string, unknown>) => {
    setInfo((current) => (current
      ? {
        ...current,
        tunnel: (json.tunnel as TunnelState | undefined) ?? current.tunnel,
        tunnelConfig: (json.tunnelConfig as TunnelConfigInfo | undefined) ?? current.tunnelConfig,
      }
      : current));
  };

  const pairingAction = (scope: Scope, mode: "toggle" | "random" | "set", payload: Record<string, unknown> = {}) =>
    run(`${scope}:${mode}`, async () => {
      const json = await post({ action: "pairing-code", scope, mode, ...payload });
      if (json.pairing) setInfo((current) => (current ? { ...current, pairing: json.pairing as RemoteInfo["pairing"] } : current));
      setEditing(null);
      setDraft("");
    });

  const tunnelAction = (action: "tunnel-start" | "tunnel-stop" | "tunnel-uninstall") =>
    run(action, async () => {
      setCheck(null);
      applyTunnelState(await post({ action }));
    });

  const runCheck = () =>
    run("tunnel-check", async () => {
      const json = await post({ action: "tunnel-check" });
      setCheck(json.check as CheckResult);
    });

  const toggleAutoStart = (enabled: boolean) =>
    run("tunnel-autostart", async () => {
      applyTunnelState(await post({ action: "tunnel-autostart", enabled }));
    });

  const copyText = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied((current) => (current === key ? null : current)), 1500);
    } catch {
      setError(t("remote.copyFailed"));
    }
  };

  // ---- styles -----------------------------------------------------------------
  const sectionStyle: React.CSSProperties = { display: "grid", gap: 12, marginTop: 6 };
  const cardStyle: React.CSSProperties = {
    border: "1px solid var(--border)",
    borderRadius: 12,
    background: "var(--bg)",
    padding: "14px 16px 16px",
  };
  const cardHeadStyle: React.CSSProperties = {
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
    paddingBottom: 12, borderBottom: "1px solid var(--border)",
  };
  const badgeStyle: React.CSSProperties = {
    display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
    width: 20, height: 20, borderRadius: 999, border: "1px solid var(--border)",
    fontSize: 11, fontWeight: 700, color: "var(--text-muted)", background: "var(--bg-panel)",
  };
  const cardTitleStyle: React.CSSProperties = { fontSize: 14, fontWeight: 600, color: "var(--text)" };
  const tagStyle: React.CSSProperties = {
    fontSize: 11, padding: "2px 8px", borderRadius: 999, whiteSpace: "nowrap",
    border: "1px solid var(--border)", color: "var(--text-muted)", background: "var(--bg-panel)",
  };
  const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 10 };
  const labelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 500, color: "var(--text-muted)", minWidth: 52 };
  const hintStyle: React.CSSProperties = { fontSize: 12, color: "var(--text-muted)", marginTop: 8, maxWidth: 520, lineHeight: 1.55 };
  const monoStyle: React.CSSProperties = {
    fontFamily: "var(--font-mono)", fontSize: 12, padding: "4px 8px", borderRadius: 6,
    background: "var(--bg-panel)", color: "var(--text)", overflowWrap: "anywhere", userSelect: "all",
  };
  const codeStyle: React.CSSProperties = {
    fontFamily: "var(--font-mono)", fontSize: 15, letterSpacing: "0.16em", fontWeight: 600,
    padding: "5px 10px", borderRadius: 7, background: "var(--bg-panel)", color: "var(--text)",
  };
  const inputStyle: React.CSSProperties = {
    height: 30, padding: "0 8px", fontSize: 12, borderRadius: 6,
    border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", width: 150,
    textTransform: "uppercase", fontFamily: "var(--font-mono)", letterSpacing: "0.1em",
  };
  const dividerStyle: React.CSSProperties = { height: 1, background: "var(--border)", margin: "14px 0 0" };

  const tunnel = info?.tunnel;
  const config = info?.tunnelConfig;
  const lanOrigin = info && info.lan[0] ? `http://${info.lan[0].address}:${info.port}/` : "";
  const tailscaleOrigin = info && info.tailscale[0] ? `http://${info.tailscale[0].address}:${info.port}/` : "";
  const tunnelOrigin = tunnel?.status === "running" && tunnel.url ? `${tunnel.url}/` : "";
  const localOrigin = info ? `http://127.0.0.1:${info.port}/` : "";

  /**
   * QR value: the entry's origin plus its secret in the URL FRAGMENT, so the secret
   * is never sent to the server, never in a log, never in a Referer.
   */
  const linkFor = (origin: string, scope: Scope) => (info && origin ? `${origin}#pair=${info.pairing[scope].secret}` : "");

  /** A card's switch with its caption: the switch alone would say nothing. */
  const switchWithCaption = (scope: Scope, checked: boolean) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
      <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{t("remote.codeEnable")}</span>
      <ConfigSwitch
        checked={checked}
        disabled={busy !== null}
        label={`${t("remote.codeEnable")} (${t(`remote.tag${scope === "lan" ? "Lan" : scope === "public" ? "Public" : "Tailscale"}`)})`}
        onChange={(next) => void pairingAction(scope, "toggle", { enabled: next })}
      />
    </div>
  );

  /** One card: number, name, what it is, its switch, then body | QR slot. */
  const card = (options: {
    index: number;
    title: string;
    tag: string;
    scope: Scope;
    action: React.ReactNode;
    qrValue: string;
    emptyQrHint: string;
    children: React.ReactNode;
  }) => (
    <section style={cardStyle} aria-label={options.title}>
      <header style={cardHeadStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flexWrap: "wrap" }}>
          <span style={badgeStyle} aria-hidden="true">{options.index}</span>
          <span style={cardTitleStyle}>{options.title}</span>
          <span style={tagStyle}>{options.tag}</span>
        </div>
        {options.action}
      </header>
      {/* A phone has no room for a 156px square beside the text, so there the QR
          drops under it (same square, same place in every card). */}
      <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", gap: isMobile ? 12 : 18, alignItems: "flex-start", marginTop: 14 }}>
        <div style={{ flex: 1, minWidth: 0, width: isMobile ? "100%" : undefined }}>{options.children}</div>
        {/* Fixed square: the cards stay aligned whether or not this door is available. */}
        <div
          style={{
            width: QR_SLOT, height: QR_SLOT, flexShrink: 0, borderRadius: 10,
            alignSelf: isMobile ? "center" : undefined,
            display: "flex", alignItems: "center", justifyContent: "center", padding: 8,
            border: options.qrValue ? "1px solid var(--border)" : "1px dashed var(--border)",
            background: options.qrValue ? "var(--bg-panel)" : "transparent",
          }}
        >
          {options.qrValue
            ? <QrCode value={options.qrValue} size={QR_SLOT - 16} />
            : <span style={{ fontSize: 11, color: "var(--text-dim)", textAlign: "center", lineHeight: 1.5 }}>{options.emptyQrHint}</span>}
        </div>
      </div>
    </section>
  );

  /** The pairing-code line every card repeats, so the three read identically. */
  const pairingRow = (scope: Scope) => {
    if (!info) return null;
    const pairing = info.pairing[scope];
    const editingThis = editing === scope;
    return (
      <>
        <div style={rowStyle}>
          <span style={labelStyle}>{t("remote.codeLabel")}</span>
          <span style={codeStyle}>{pairing.enabled ? pairing.code : "— — —"}</span>
          <ConfigButton variant="ghost" size="small" onClick={() => void copyText(pairing.code, `${scope}:code`)} disabled={!pairing.enabled}>
            {copied === `${scope}:code` ? t("remote.copied") : t("remote.copy")}
          </ConfigButton>
          <ConfigButton variant="secondary" size="small" onClick={() => void pairingAction(scope, "random")} disabled={busy !== null}>
            {t("remote.randomize")}
          </ConfigButton>
          <ConfigButton variant="ghost" size="small" onClick={() => { setEditing(editingThis ? null : scope); setDraft(""); }} disabled={busy !== null}>
            {t("remote.custom")}
          </ConfigButton>
        </div>
        {editingThis ? (
          <div style={{ ...rowStyle, marginTop: 8 }}>
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12))}
              placeholder={t("remote.customPlaceholder")}
              style={inputStyle}
              onKeyDown={(e) => { if (e.key === "Enter" && draft.length >= 6) void pairingAction(scope, "set", { code: draft }); }}
            />
            <ConfigButton variant="primary" size="small" onClick={() => void pairingAction(scope, "set", { code: draft })} disabled={busy !== null || draft.length < 6}>
              {t("remote.saveCode")}
            </ConfigButton>
          </div>
        ) : null}
        {!pairing.enabled ? <div style={hintStyle}>{t("remote.codeOffHint")}</div> : null}
      </>
    );
  };

  /** The address line, with its copy button; `null` while the door is unavailable. */
  const addressRow = (origin: string, copyKey: string) => (
    <div style={rowStyle}>
      <span style={labelStyle}>{t("remote.lanUrlLabel")}</span>
      <span style={{ ...monoStyle, opacity: origin ? 1 : 0.6 }}>{origin || t("remote.addressPending")}</span>
      <ConfigButton variant="ghost" size="small" onClick={() => void copyText(origin, copyKey)} disabled={!origin}>
        {copied === copyKey ? t("remote.copied") : t("remote.copyUrl")}
      </ConfigButton>
    </div>
  );

  const tunnelStatusText = () => {
    if (!tunnel) return "";
    if (tunnel.restarting) return t("remote.restarting", { count: tunnel.restarts + 1 });
    if (tunnel.status === "running") return t("remote.tunnelRunning");
    if (tunnel.status === "starting" && tunnel.phase === "downloading") return t("remote.tunnelDownloading");
    if (tunnel.status === "starting") return t("remote.tunnelStarting");
    if (tunnel.status === "error") return t("remote.tunnelError");
    return t("remote.tunnelStopped");
  };

  return (
    <div className="settings-general">
      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("remote.heading")}</h3>
        <p className="settings-general-description">{t("remote.description")}</p>

        {error ? <p role="alert" className="settings-general-error">{t("remote.failed")}{error}</p> : null}
        {!info ? <p style={hintStyle}>{t("remote.loading")}</p> : null}

        {info ? (
          <>
            {/* This machine is not one of the three doors: it never asks. */}
            <div style={{ ...rowStyle, justifyContent: "space-between", marginTop: 12, paddingBottom: 12, borderBottom: "1px solid var(--border)" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>{t("remote.localLabel")}</div>
                <div style={hintStyle}>{t("remote.localHint")}</div>
                <div style={{ ...monoStyle, marginTop: 6, display: "inline-block" }}>{localOrigin}</div>
              </div>
              <ConfigButton variant="ghost" size="small" onClick={() => void copyText(localOrigin, "local")}>
                {copied === "local" ? t("remote.copied") : t("remote.copy")}
              </ConfigButton>
            </div>

            <div style={sectionStyle}>
              {/* 1 · LAN */}
              {card({
                index: 1,
                title: t("remote.lanHeading"),
                tag: t("remote.tagLan"),
                scope: "lan",
                qrValue: lanOrigin ? linkFor(lanOrigin, "lan") : "",
                emptyQrHint: t("remote.qrEmptyNoAddress"),
                action: switchWithCaption("lan", info.pairing.lan.enabled),
                children: (
                  <>
                    <div style={hintStyle}>{t("remote.lanIntro")}</div>
                    {pairingRow("lan")}
                    {addressRow(lanOrigin, "lan:origin")}
                    {!lanOrigin ? <div style={hintStyle}>{t("remote.noChannel")}</div> : null}
                  </>
                ),
              })}

              {/* 2 · Tailscale */}
              {card({
                index: 2,
                title: t("remote.tailscaleHeading"),
                tag: t("remote.tagTailscale"),
                scope: "tailscale",
                qrValue: tailscaleOrigin ? linkFor(tailscaleOrigin, "tailscale") : "",
                emptyQrHint: t("remote.qrEmptyTailscale"),
                action: switchWithCaption("tailscale", info.pairing.tailscale.enabled),
                children: (
                  <>
                    <div style={hintStyle}>{tailscaleOrigin ? t("remote.tailscaleAddressHint") : t("remote.noTailscale")}</div>
                    {pairingRow("tailscale")}
                    {addressRow(tailscaleOrigin, "tailscale:origin")}
                  </>
                ),
              })}

              {/* 3 · Public tunnel */}
              {card({
                index: 3,
                title: t("remote.tunnelLabel"),
                tag: t("remote.tagPublic"),
                scope: "public",
                qrValue: tunnelOrigin ? linkFor(tunnelOrigin, "public") : "",
                emptyQrHint: t("remote.qrEmptyPublic"),
                action: switchWithCaption("public", info.pairing.public.enabled),
                children: (
                  <>
                    <div style={hintStyle}>{t("remote.tunnelHint")}</div>
                    <div style={hintStyle}>{t("remote.currentAddressHint")}</div>
                    {pairingRow("public")}
                    {addressRow(tunnelOrigin, "tunnel")}
                    {tunnel?.restarts ? <div style={hintStyle}>{t("remote.restarts", { count: tunnel.restarts })}</div> : null}

                    <div style={dividerStyle} />
                    <div style={{ ...rowStyle, justifyContent: "space-between", marginTop: 12 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("remote.tunnelStatus")}</div>
                        <div style={{ fontSize: 13, color: "var(--text)", marginTop: 2 }}>{tunnelStatusText()}</div>
                        {tunnel?.binaryInstalled ? <div style={hintStyle}>{t("remote.tunnelInstalled")}</div> : null}
                        {tunnel?.status === "error" && tunnel.error ? (
                          <p role="alert" style={{ ...hintStyle, color: "#ef4444" }}>{tunnel.error}</p>
                        ) : null}
                        {check ? (
                          <p style={{ ...hintStyle, color: check.ok ? "var(--accent)" : "#ef4444" }}>
                            {check.ok
                              ? t("remote.checkOk", { ms: String(check.ms ?? 0) })
                              : `${t("remote.checkFailed")}${check.error ?? ""}${check.dnsFailure ? ` — ${t("remote.checkDns")}` : ""}`}
                          </p>
                        ) : null}
                      </div>
                      <div style={{ display: "flex", gap: 8, flexShrink: 0, flexWrap: "wrap" }}>
                        {tunnel?.status === "running" || tunnel?.status === "starting" ? (
                          <>
                            <ConfigButton variant="secondary" size="small" onClick={() => void tunnelAction("tunnel-stop")} disabled={busy !== null}>
                              {busy === "tunnel-stop" ? t("remote.stopping") : t("remote.tunnelStop")}
                            </ConfigButton>
                            {tunnel?.status === "running" ? (
                              <ConfigButton variant="ghost" size="small" onClick={() => void runCheck()} disabled={busy !== null}>
                                {busy === "tunnel-check" ? t("remote.checking") : t("remote.check")}
                              </ConfigButton>
                            ) : null}
                          </>
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

                    <div style={dividerStyle} />
                    <div style={{ ...rowStyle, justifyContent: "space-between", marginTop: 12 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("remote.autoStartLabel")}</div>
                        <div style={hintStyle}>{t("remote.autoStartHint")}</div>
                      </div>
                      <ConfigSwitch
                        checked={config?.autoStart === true}
                        disabled={busy !== null}
                        label={t("remote.autoStartLabel")}
                        onChange={(next) => void toggleAutoStart(next)}
                      />
                    </div>

                  </>
                ),
              })}
            </div>

            {info.passwordEnabled ? <ConfigNotice>{t("remote.envPasswordNotice")}</ConfigNotice> : null}
          </>
        ) : null}
      </section>
    </div>
  );
}
