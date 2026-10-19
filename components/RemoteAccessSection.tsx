"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { TunnelMode } from "@/lib/tunnel-config-view";
import { ConfigButton, ConfigNotice, ConfigSwitch } from "./SettingsUi";
import { QrCode } from "./QrCode";

interface RemoteAddress { name: string; address: string }
interface TunnelState {
  status: "stopped" | "starting" | "running" | "error";
  mode: TunnelMode;
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
/** The fixed-domain settings; the token only as `hasToken` (the server never echoes it). */
interface TunnelConfigInfo {
  mode: TunnelMode;
  hostname: string;
  autoStart: boolean;
  hasToken: boolean;
  path: string;
}
interface PairingScope { enabled: boolean; code: string; secret: string }
interface RemoteInfo {
  port: number;
  lan: RemoteAddress[];
  tailscale: RemoteAddress[];
  tunnel: TunnelState;
  tunnelConfig: TunnelConfigInfo;
  pairing: { lan: PairingScope; public: PairingScope };
  passwordEnabled: boolean;
  authSource: "env" | "env-disabled" | "generated" | "disabled";
}
type Scope = "lan" | "public";
interface CheckResult {
  ok: boolean;
  status?: number;
  ms?: number;
  error?: string;
  dnsFailure?: boolean;
}

/**
 * Settings › Remote access.
 *
 * Two independent entry points, one below the other — never a dropdown, because a
 * QR code must say which door it opens:
 *
 *   局域网  the same Wi-Fi: a code (or its QR) that only works on this network;
 *   公网    the Cloudflare tunnel: its own code, its own switch, recommended on.
 *
 * The tunnel itself has two modes (a random quick tunnel or the operator's fixed
 * domain). They are mutually exclusive, and the fixed domain is two plain input
 * boxes plus an explicit Save: the token never travels back to this page, so a
 * blank box means "keep the saved one", and nothing is written until Save is
 * confirmed.
 *
 * A device pairs with a short code or by scanning the QR (the QR carries a
 * high-entropy secret in the URL fragment, so it never reaches a server log). This
 * machine needs neither: 127.0.0.1 is always let in.
 */
export function RemoteAccessSection() {
  const { t } = useI18n();
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [editing, setEditing] = useState<Scope | null>(null);
  const [draft, setDraft] = useState("");
  const [check, setCheck] = useState<CheckResult | null>(null);
  // Fixed-domain drafts. `null` means "not chosen yet": the saved mode applies.
  const [modeDraft, setModeDraft] = useState<TunnelMode | null>(null);
  const [tokenDraft, setTokenDraft] = useState("");
  const [hostnameDraft, setHostnameDraft] = useState("");
  const [draftsReady, setDraftsReady] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/remote");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = await res.json() as RemoteInfo;
      setInfo(next);
      if (!draftsReady) {
        setModeDraft(next.tunnelConfig.mode);
        setHostnameDraft(next.tunnelConfig.hostname);
        setDraftsReady(true);
      }
    } catch (err) {
      setError(String(err));
    }
  }, [draftsReady]);

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

  /**
   * Save the fixed domain. Both fields are drafts: a blank token box keeps the
   * saved credential (this page never receives it), and the confirmation names the
   * consequence — the old public address stops working at once.
   */
  const saveTunnelConfig = () => {
    const mode: TunnelMode = modeDraft ?? info?.tunnelConfig.mode ?? "quick";
    if (!window.confirm(t("remote.namedSaveConfirm"))) return;
    void run("tunnel-config-save", async () => {
      const json = await post({
        action: "tunnel-config-save",
        mode,
        ...(tokenDraft.trim() ? { token: tokenDraft.trim() } : {}),
        hostname: mode === "named" ? hostnameDraft.trim() : "",
        confirm: true,
      });
      applyTunnelState(json);
      setTokenDraft("");
      const config = json.tunnelConfig as TunnelConfigInfo | undefined;
      if (config) setHostnameDraft(config.hostname);
    });
  };

  const clearTunnelConfig = () => {
    if (!window.confirm(t("remote.namedClearConfirm"))) return;
    void run("tunnel-config-clear", async () => {
      const json = await post({ action: "tunnel-config-clear", confirm: true });
      applyTunnelState(json);
      setTokenDraft("");
      setHostnameDraft("");
      setModeDraft("quick");
      setCheck(null);
    });
  };

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

  const rowStyle: React.CSSProperties = {
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16,
    padding: "12px 0", borderBottom: "1px solid var(--border)",
  };
  const labelStyle: React.CSSProperties = { fontSize: 13, fontWeight: 500, color: "var(--text)" };
  const hintStyle: React.CSSProperties = { fontSize: 12, color: "var(--text-muted)", marginTop: 3, maxWidth: 520, lineHeight: 1.5 };
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
  /** The fixed-domain fields: ordinary text, no upper-casing — a token and a hostname. */
  const fieldStyle: React.CSSProperties = {
    height: 30, padding: "0 8px", fontSize: 12, borderRadius: 6,
    border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)",
    width: 260, maxWidth: "100%", fontFamily: "var(--font-mono)",
  };

  const tunnel = info?.tunnel;
  const config = info?.tunnelConfig;
  const mode = modeDraft ?? config?.mode ?? "quick";
  const lanOrigin = info && info.lan[0] ? `http://${info.lan[0].address}:${info.port}/` : "";
  const tunnelOrigin = tunnel?.status === "running" && tunnel.url ? `${tunnel.url}/` : "";
  const localOrigin = info ? `http://127.0.0.1:${info.port}/` : "";

  /**
   * QR value: the entry's origin plus its secret in the URL FRAGMENT, so the secret
   * is never sent to the server, never in a log, never in a Referer.
   */
  const linkFor = (origin: string, scope: Scope) => (info && origin ? `${origin}#pair=${info.pairing[scope].secret}` : "");

  const pairingBlock = (scope: Scope, origin: string, hintKey: string) => {
    if (!info) return null;
    const pairing = info.pairing[scope];
    const editingThis = editing === scope;
    return (
      <>
        <div style={rowStyle}>
          <div style={{ minWidth: 0 }}>
            <div style={labelStyle}>{t("remote.codeLabel")}</div>
            <div style={hintStyle}>{t(pairing.enabled ? hintKey : "remote.codeOffHint")}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
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
              <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
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
          </div>
          <ConfigSwitch
            checked={pairing.enabled}
            disabled={busy !== null}
            label={t("remote.codeEnable")}
            onChange={(next) => void pairingAction(scope, "toggle", { enabled: next })}
          />
        </div>
        {pairing.enabled && origin ? (
          <div style={{ ...rowStyle, alignItems: "flex-start", borderBottom: "none" }}>
            <div style={{ minWidth: 0 }}>
              {scope === "lan" ? (
                <>
                  <div style={labelStyle}>{t("remote.lanUrlLabel")}</div>
                  <div style={{ ...monoStyle, marginTop: 6, display: "inline-block" }}>{origin}</div>
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <ConfigButton variant="ghost" size="small" onClick={() => void copyText(origin, `${scope}:origin`)}>
                      {copied === `${scope}:origin` ? t("remote.copied") : t("remote.copyUrl")}
                    </ConfigButton>
                  </div>
                </>
              ) : null}
              <div style={hintStyle}>{t("remote.qrHint")}</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, flexShrink: 0 }}>
              <QrCode value={linkFor(origin, scope)} size={scope === "lan" ? 150 : 170} />
            </div>
          </div>
        ) : null}
      </>
    );
  };

  /** One status line saying what the tunnel is doing right now, in the chosen mode. */
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
            {/* This machine */}
            <div style={rowStyle}>
              <div style={{ minWidth: 0 }}>
                <div style={labelStyle}>{t("remote.localLabel")}</div>
                <div style={hintStyle}>{t("remote.localHint")}</div>
                <div style={{ ...monoStyle, marginTop: 6, display: "inline-block" }}>{localOrigin}</div>
              </div>
              <ConfigButton variant="ghost" size="small" onClick={() => void copyText(localOrigin, "local")}>
                {copied === "local" ? t("remote.copied") : t("remote.copy")}
              </ConfigButton>
            </div>

            {/* Entry 1: LAN */}
            <h4 className="settings-general-heading" style={{ fontSize: 13, marginTop: 18 }}>{t("remote.lanHeading")}</h4>
            <p style={hintStyle}>{t("remote.lanIntro")}</p>
            {lanOrigin ? pairingBlock("lan", lanOrigin, "remote.codeHintLan") : (
              <p style={hintStyle}>{t("remote.noChannel")}</p>
            )}

            {/* Entry 2: public tunnel */}
            <h4 className="settings-general-heading" style={{ fontSize: 13, marginTop: 22 }}>{t("remote.tunnelLabel")}</h4>

            {/* The address a phone should open: the panel's own, never the history's. */}
            <div style={rowStyle}>
              <div style={{ minWidth: 0 }}>
                <div style={labelStyle}>{t("remote.currentAddress")}</div>
                <div style={{ ...monoStyle, marginTop: 6, display: "inline-block" }}>
                  {tunnelOrigin || "—"}
                </div>
                <div style={hintStyle}>{t("remote.currentAddressHint")}</div>
                {tunnel?.restarts ? <div style={hintStyle}>{t("remote.restarts", { count: tunnel.restarts })}</div> : null}
              </div>
              <ConfigButton
                variant="ghost"
                size="small"
                onClick={() => void copyText(tunnelOrigin, "tunnel")}
                disabled={!tunnelOrigin}
              >
                {copied === "tunnel" ? t("remote.copied") : t("remote.copy")}
              </ConfigButton>
            </div>

            <div style={rowStyle}>
              <div style={{ minWidth: 0 }}>
                <div style={labelStyle}>{t("remote.tunnelStatus")}</div>
                <div style={{ ...hintStyle, color: "var(--text)" }}>{tunnelStatusText()}</div>
                {tunnel?.binaryInstalled ? <div style={hintStyle}>{t("remote.tunnelInstalled")}</div> : null}
                {tunnel?.status === "error" && tunnel.error ? (
                  <p role="alert" style={{ ...hintStyle, color: "#ef4444" }}>{tunnel.error}</p>
                ) : null}
                {check ? (
                  <p style={{ ...hintStyle, color: check.ok ? "var(--accent)" : "#ef4444", marginTop: 6 }}>
                    {check.ok
                      ? t("remote.checkOk", { ms: String(check.ms ?? 0) })
                      : `${t("remote.checkFailed")}${check.error ?? ""}${check.dnsFailure ? ` — ${t("remote.checkDns")}` : ""}`}
                  </p>
                ) : null}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, flexShrink: 0 }}>
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

            {/* Which kind of tunnel: one or the other, saved explicitly. */}
            <div style={{ ...rowStyle, alignItems: "flex-start" }}>
              <div style={{ minWidth: 0 }}>
                <div style={labelStyle}>{t("remote.modeLabel")}</div>
                <div style={hintStyle}>{t("remote.modeHint")}</div>
                <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  <ConfigButton
                    variant={mode === "quick" ? "primary" : "secondary"}
                    size="small"
                    onClick={() => setModeDraft("quick")}
                    disabled={busy !== null}
                  >
                    {t("remote.modeQuick")}
                  </ConfigButton>
                  <ConfigButton
                    variant={mode === "named" ? "primary" : "secondary"}
                    size="small"
                    onClick={() => setModeDraft("named")}
                    disabled={busy !== null}
                  >
                    {t("remote.modeNamed")}
                  </ConfigButton>
                </div>
                {mode === "quick" ? <div style={hintStyle}>{t("remote.tunnelHint")}</div> : null}
              </div>
            </div>

            {mode === "named" ? (
              <div style={{ ...rowStyle, alignItems: "flex-start", flexDirection: "column", gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={labelStyle}>{t("remote.namedTokenLabel")}</div>
                  <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                    <input
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={tokenDraft}
                      onChange={(e) => setTokenDraft(e.target.value)}
                      placeholder={config?.hasToken ? t("remote.namedTokenSaved") : t("remote.namedTokenPlaceholder")}
                      style={fieldStyle}
                      aria-label={t("remote.namedTokenLabel")}
                    />
                  </div>
                  <div style={hintStyle}>{t("remote.namedSetupHint", { port: String(info.port) })}</div>
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={labelStyle}>{t("remote.namedHostnameLabel")}</div>
                  <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                    <input
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      value={hostnameDraft}
                      onChange={(e) => setHostnameDraft(e.target.value.trim().toLowerCase())}
                      placeholder={t("remote.namedHostnamePlaceholder")}
                      style={fieldStyle}
                      aria-label={t("remote.namedHostnameLabel")}
                    />
                  </div>
                  {!config?.hasToken && !tokenDraft.trim() ? (
                    <div style={hintStyle}>{t("remote.namedNotConfigured")}</div>
                  ) : null}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <ConfigButton
                    variant="primary"
                    size="small"
                    onClick={saveTunnelConfig}
                    disabled={busy !== null || !hostnameDraft.trim() || (!config?.hasToken && !tokenDraft.trim())}
                  >
                    {busy === "tunnel-config-save" ? t("remote.namedSaving") : t("remote.namedSave")}
                  </ConfigButton>
                  <ConfigButton
                    variant="ghost"
                    size="small"
                    onClick={clearTunnelConfig}
                    disabled={busy !== null || (!config?.hasToken && !config?.hostname)}
                  >
                    {t("remote.namedClear")}
                  </ConfigButton>
                </div>
              </div>
            ) : (
              <div style={{ ...rowStyle, alignItems: "center" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={hintStyle}>{config?.mode === "named" ? t("remote.switchToQuickHint") : t("remote.modeHint")}</div>
                </div>
                <ConfigButton
                  variant="secondary"
                  size="small"
                  onClick={saveTunnelConfig}
                  disabled={busy !== null || config?.mode === "quick"}
                >
                  {busy === "tunnel-config-save" ? t("remote.namedSaving") : t("remote.namedSave")}
                </ConfigButton>
              </div>
            )}

            <div style={rowStyle}>
              <div style={{ minWidth: 0 }}>
                <div style={labelStyle}>{t("remote.autoStartLabel")}</div>
                <div style={hintStyle}>{t("remote.autoStartHint")}</div>
              </div>
              <ConfigSwitch
                checked={config?.autoStart === true}
                disabled={busy !== null}
                label={t("remote.autoStartLabel")}
                onChange={(next) => void toggleAutoStart(next)}
              />
            </div>

            {tunnelOrigin ? pairingBlock("public", tunnelOrigin, "remote.codeHintPublic") : (
              <p style={hintStyle}>{t("remote.publicNeedsTunnel")}</p>
            )}
            {!info.pairing.public.enabled ? (
              <ConfigNotice>{t("remote.publicCodeOffNotice")}</ConfigNotice>
            ) : null}
            {info.passwordEnabled ? <ConfigNotice>{t("remote.envPasswordNotice")}</ConfigNotice> : null}
          </>
        ) : null}
      </section>
    </div>
  );
}
