"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ModelSelector, type ModelSelectorOption } from "./ModelSelector";

interface AdvisorSettings {
  mode: "off" | "manual" | "auto";
  provider: string;
  modelId: string;
  interruptOn: "none" | "concern" | "blocker";
  autoMinToolCalls: number;
  maxNotes: number;
}

const DEFAULTS: AdvisorSettings = {
  mode: "off",
  provider: "",
  modelId: "",
  interruptOn: "concern",
  autoMinToolCalls: 8,
  maxNotes: 4,
};

export function AdvisorConfig({ cwd, embedded = false }: { cwd: string | null; /** Rendered inside Settings › General: only the section, no page wrapper. */ embedded?: boolean }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<AdvisorSettings>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<ModelSelectorOption[]>([]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([
      fetch("/api/advisor-settings").then((r) => (r.ok ? r.json() : null)),
      cwd ? fetch(`/api/models?cwd=${encodeURIComponent(cwd)}`).then((r) => (r.ok ? r.json() : null)) : Promise.resolve(null),
    ])
      .then(([advisorRes, modelsRes]) => {
        if (!alive) return;
        if (advisorRes?.data) setSettings({ ...DEFAULTS, ...advisorRes.data });
        const list = modelsRes?.modelList as { id: string; name: string; provider: string }[] | undefined;
        if (Array.isArray(list)) {
          setModelOptions(list.map((m) => ({ provider: m.provider, modelId: m.id, name: m.name })));
        }
      })
      .catch((err) => alive && setError(String(err)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [cwd]);

  const save = async (patch: Partial<AdvisorSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/advisor-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.data) setSettings({ ...DEFAULTS, ...json.data });
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    padding: "14px 0",
    borderBottom: "1px solid var(--border)",
  };
  const labelStyle: React.CSSProperties = { fontSize: 13, fontWeight: 500, color: "var(--text)" };
  const hintStyle: React.CSSProperties = { fontSize: 12, color: "var(--text-muted)", marginTop: 3, maxWidth: 460, lineHeight: 1.5 };
  const selectStyle: React.CSSProperties = {
    height: 32,
    padding: "0 10px",
    fontSize: 13,
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: "var(--bg)",
    color: "var(--text)",
    minWidth: 180,
  };

  if (loading) {
    return <p style={{ color: "var(--text-muted)", fontSize: 13 }}>{t("advisor.loading")}</p>;
  }

  const body = (
    <>
      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("advisor.title")}</h3>
        <p className="settings-general-description">{t("advisor.description")}</p>
      </section>

      {error ? <p role="alert" className="settings-general-error">{t("advisor.saveFailed")}{error}</p> : null}

      <section className="settings-general-section">
        <div style={{ marginTop: 12 }}>
          {/* 模式 */}
          <div style={rowStyle}>
            <div>
              <div style={labelStyle}>{t("advisor.modeLabel")}</div>
              <div style={hintStyle}>{t("advisor.modeHint")}</div>
            </div>
            <select style={selectStyle} value={settings.mode} onChange={(e) => save({ mode: e.target.value as AdvisorSettings["mode"] })}>
              <option value="off">{t("advisor.modeOff")}</option>
              <option value="manual">{t("advisor.modeManual")}</option>
              <option value="auto">{t("advisor.modeAuto")}</option>
            </select>
          </div>

          {/* 顾问模型 */}
          <div style={rowStyle}>
            <div>
              <div style={labelStyle}>{t("advisor.modelLabel")}</div>
              <div style={hintStyle}>{t("advisor.modelHint")}</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <ModelSelector
                options={modelOptions}
                value={settings.provider && settings.modelId ? { provider: settings.provider, modelId: settings.modelId } : null}
                onChange={(provider, modelId) => save({ provider, modelId })}
                onClear={() => save({ provider: "", modelId: "" })}
                emptyLabel={t("advisor.modelReuse")}
                ariaLabel={t("advisor.modelAria")}
                variant="field"
              />
            </div>
          </div>

          {/* 打断策略 */}
          <div style={rowStyle}>
            <div>
              <div style={labelStyle}>{t("advisor.interruptLabel")}</div>
              <div style={hintStyle}>{t("advisor.interruptHint")}</div>
            </div>
            <select style={selectStyle} value={settings.interruptOn} onChange={(e) => save({ interruptOn: e.target.value as AdvisorSettings["interruptOn"] })}>
              <option value="none">{t("advisor.interruptNone")}</option>
              <option value="concern">{t("advisor.interruptConcern")}</option>
              <option value="blocker">{t("advisor.interruptBlocker")}</option>
            </select>
          </div>

          {/* 自动阈值 */}
          <div style={rowStyle}>
            <div>
              <div style={labelStyle}>{t("advisor.autoMinLabel")}</div>
              <div style={hintStyle}>{t("advisor.autoMinHint")}</div>
            </div>
            <input
              type="number"
              min={1}
              max={100}
              value={settings.autoMinToolCalls}
              onChange={(e) => setSettings({ ...settings, autoMinToolCalls: Number(e.target.value) })}
              onBlur={() => save({ autoMinToolCalls: settings.autoMinToolCalls })}
              style={{ ...selectStyle, minWidth: 70, width: 70 }}
            />
          </div>

          {/* 每次最多意见数 */}
          <div style={{ ...rowStyle, borderBottom: "none" }}>
            <div>
              <div style={labelStyle}>{t("advisor.maxNotesLabel")}</div>
              <div style={hintStyle}>{t("advisor.maxNotesHint")}</div>
            </div>
            <input
              type="number"
              min={1}
              max={8}
              value={settings.maxNotes}
              onChange={(e) => setSettings({ ...settings, maxNotes: Number(e.target.value) })}
              onBlur={() => save({ maxNotes: settings.maxNotes })}
              style={{ ...selectStyle, minWidth: 70, width: 70 }}
            />
          </div>
        </div>

        <div style={{ marginTop: 20, fontSize: 12, color: saved ? "#16a34a" : "var(--text-muted)" }}>
          {saving ? t("advisor.saving") : saved ? t("advisor.saved") : t("advisor.saveHint")}
        </div>
      </section>
    </>
  );

  // Inside Settings › General the page wrapper and its error line come from there.
  return embedded ? body : <div className="settings-general">{body}</div>;
}
