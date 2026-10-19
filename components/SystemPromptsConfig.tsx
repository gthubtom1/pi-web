"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  ConfigButton,
  ConfigDetail,
  ConfigDetailHeader,
  ConfigDetailHeaderInfo,
  ConfigDetailStack,
  ConfigEmptyState,
  ConfigField,
  ConfigPanelShell,
  ConfigSidebar,
  ConfigSidebarGroupLabel,
  ConfigSidebarItem,
  ConfigSidebarList,
  ConfigSidebarText,
  ConfigSplitView,
} from "./SettingsUi";

interface Persona {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  personality: string;
}

interface PersonasResponse {
  personas: Persona[];
  defaultPersonaId: string | null;
  legacyPersonality: string;
  hasPersonas: boolean;
}

interface SystemPromptsData {
  rules: string;
  rulesPath: string;
  agents: string;
  agentsPath: string;
}

type Selection = { kind: "persona"; id: string } | { kind: "rules" } | { kind: "agents" };

const inputStyle: React.CSSProperties = {
  width: "100%",
  height: 34,
  padding: "0 9px",
  border: "1px solid var(--border)",
  borderRadius: 5,
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
  boxSizing: "border-box",
};

const textareaStyle: React.CSSProperties = {
  width: "100%",
  minHeight: 220,
  padding: 10,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg)",
  color: "var(--text)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  lineHeight: 1.6,
  resize: "vertical",
  boxSizing: "border-box",
};

export function SystemPromptsConfig({ cwd, embedded = false, onClose }: { cwd: string | null; embedded?: boolean; onClose?: () => void }) {
  const { t } = useI18n();
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [legacy, setLegacy] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);

  // Editing buffers for the selected persona / the global rules / agents.
  const [nameText, setNameText] = useState("");
  const [personalityText, setPersonalityText] = useState("");
  const [rulesText, setRulesText] = useState("");
  const [agentsText, setAgentsText] = useState("");
  const [rulesMeta, setRulesMeta] = useState<SystemPromptsData | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [injectMode, setInjectMode] = useState<"every-turn" | "cached">("every-turn");

  const loadPersonas = useCallback(async () => {
    const res = await fetch("/api/personas");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as PersonasResponse;
    setPersonas(data.personas);
    setDefaultId(data.defaultPersonaId);
    setLegacy(data.legacyPersonality);
    return data;
  }, []);

  const loadSystem = useCallback(async () => {
    const res = await fetch(`/api/system-prompts${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as { data: SystemPromptsData };
    setRulesMeta(json.data);
    setRulesText(json.data.rules);
    setAgentsText(json.data.agents);
    return json.data;
  }, [cwd]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([
      loadPersonas(),
      loadSystem(),
      fetch("/api/persona-inject").then((r) => (r.ok ? r.json() : null)).then((d: { data?: { mode?: string } } | null) => {
        if (d?.data?.mode === "cached" || d?.data?.mode === "every-turn") setInjectMode(d.data.mode);
      }).catch(() => {}),
    ])
      .then(([p]) => {
        if (!alive) return;
        // Land on a sensible first selection.
        setSelection(p.personas.length > 0 ? { kind: "persona", id: p.personas[0].id } : { kind: "rules" });
      })
      .catch((err) => alive && setError(String(err)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [loadPersonas, loadSystem]);

  // When a persona is selected, copy its fields into the buffers.
  useEffect(() => {
    if (selection?.kind !== "persona") return;
    const persona = personas.find((p) => p.id === selection.id);
    if (!persona) return;
    setNameText(persona.name);
    setPersonalityText(persona.personality);
  }, [selection, personas]);

  const changeInjectMode = async (mode: "every-turn" | "cached") => {
    setInjectMode(mode);
    try {
      await fetch("/api/persona-inject", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) });
    } catch (err) {
      setError(String(err));
    }
  };

  const refresh = useCallback(async () => {
    await Promise.all([loadPersonas(), loadSystem()]);
    window.dispatchEvent(new CustomEvent("pi-web:personas-changed"));
  }, [loadPersonas, loadSystem]);

  const notifySaved = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };

  const savePersona = async () => {
    if (selection?.kind !== "persona") return;
    setSaving(true); setError(null);
    try {
      const res = await fetch("/api/personas", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", id: selection.id, name: nameText, personality: personalityText }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `HTTP ${res.status}`);
      await refresh();
      notifySaved();
    } catch (err) { setError(String(err)); } finally { setSaving(false); }
  };

  const createPersona = async () => {
    setSaving(true); setError(null);
    try {
      const res = await fetch("/api/personas", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", name: t("prompts.new"), personality: "" }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `HTTP ${res.status}`);
      const json = await res.json() as { persona: Persona };
      await refresh();
      setSelection({ kind: "persona", id: json.persona.id });
    } catch (err) { setError(String(err)); } finally { setSaving(false); }
  };

  const importLegacy = async () => {
    setSaving(true); setError(null);
    try {
      const res = await fetch("/api/personas", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", name: "PERSONALITY.md", personality: legacy }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `HTTP ${res.status}`);
      const json = await res.json() as { persona: Persona };
      await refresh();
      setSelection({ kind: "persona", id: json.persona.id });
    } catch (err) { setError(String(err)); } finally { setSaving(false); }
  };

  const personaAction = async (action: "duplicate" | "delete" | "set-default" | "clear-default") => {
    if (selection?.kind !== "persona") return;
    if (action === "delete" && !window.confirm(t("prompts.deleteConfirm"))) return;
    setSaving(true); setError(null);
    try {
      const body = action === "clear-default"
        ? { action: "set-default", id: null }
        : { action, id: selection.id };
      const res = await fetch("/api/personas", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `HTTP ${res.status}`);
      if (action === "duplicate") {
        const json = await res.json() as { persona: Persona };
        await refresh();
        setSelection({ kind: "persona", id: json.persona.id });
      } else if (action === "delete") {
        await refresh();
        setSelection({ kind: "rules" });
      } else {
        await refresh();
      }
    } catch (err) { setError(String(err)); } finally { setSaving(false); }
  };

  const saveGlobal = async () => {
    setSaving(true); setError(null);
    try {
      const res = await fetch("/api/system-prompts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules: rulesText, agents: agentsText, cwd: cwd || undefined }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `HTTP ${res.status}`);
      const json = await res.json() as { data: SystemPromptsData };
      setRulesMeta(json.data);
      notifySaved();
    } catch (err) { setError(String(err)); } finally { setSaving(false); }
  };

  const selectedPersona = useMemo(
    () => (selection?.kind === "persona" ? personas.find((p) => p.id === selection.id) ?? null : null),
    [selection, personas],
  );

  const detail = () => {
    if (!selection) return <ConfigEmptyState>{t("prompts.loading")}</ConfigEmptyState>;

    if (selection.kind === "rules") {
      return (
        <ConfigDetail>
          <ConfigDetailHeader>
            <ConfigDetailHeaderInfo>
              <div className="config-detail-title">{t("prompts.rulesHeading")}</div>
              <div className="config-detail-path">{rulesMeta?.rulesPath}</div>
            </ConfigDetailHeaderInfo>
            <ConfigButton variant="primary" size="small" onClick={() => void saveGlobal()} disabled={saving}>
              {saving ? t("prompts.saving") : saved ? t("prompts.saved") : t("prompts.save")}
            </ConfigButton>
          </ConfigDetailHeader>
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 10px" }}>{t("prompts.rulesHint")}</p>
          <textarea value={rulesText} onChange={(e) => setRulesText(e.target.value)} style={textareaStyle} />
        </ConfigDetail>
      );
    }

    if (selection.kind === "agents") {
      return (
        <ConfigDetail>
          <ConfigDetailHeader>
            <ConfigDetailHeaderInfo>
              <div className="config-detail-title">{t("prompts.agentsHeading")}</div>
              <div className="config-detail-path">{rulesMeta?.agentsPath}</div>
            </ConfigDetailHeaderInfo>
            <ConfigButton variant="primary" size="small" onClick={() => void saveGlobal()} disabled={saving}>
              {saving ? t("prompts.saving") : saved ? t("prompts.saved") : t("prompts.save")}
            </ConfigButton>
          </ConfigDetailHeader>
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 10px" }}>{t("prompts.agentsHint")}</p>
          <textarea value={agentsText} onChange={(e) => setAgentsText(e.target.value)} style={{ ...textareaStyle, minHeight: 180 }} />
        </ConfigDetail>
      );
    }

    // Persona detail.
    return (
      <ConfigDetail>
        <ConfigDetailHeader>
          <ConfigDetailHeaderInfo>
            <div className="config-detail-title">
              {nameText || selectedPersona?.name || ""}
              {defaultId === selection.id && (
                <span className="config-scope-tag" style={{ marginLeft: 8 }}>{t("prompts.default")}</span>
              )}
            </div>
          </ConfigDetailHeaderInfo>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {defaultId !== selection.id && (
              <ConfigButton size="small" variant="ghost" onClick={() => void personaAction("set-default")} disabled={saving}>{t("prompts.setDefault")}</ConfigButton>
            )}
            {defaultId === selection.id && (
              <ConfigButton size="small" variant="ghost" onClick={() => void personaAction("clear-default")} disabled={saving} title={t("prompts.clearDefault")}>{t("prompts.clearDefault")}</ConfigButton>
            )}
            <ConfigButton size="small" variant="ghost" onClick={() => void personaAction("duplicate")} disabled={saving}>{t("prompts.duplicate")}</ConfigButton>
            <ConfigButton size="small" variant="danger" onClick={() => void personaAction("delete")} disabled={saving}>{t("prompts.delete")}</ConfigButton>
            <ConfigButton size="small" variant="primary" onClick={() => void savePersona()} disabled={saving}>
              {saving ? t("prompts.saving") : saved ? t("prompts.saved") : t("prompts.save")}
            </ConfigButton>
          </div>
        </ConfigDetailHeader>

        <ConfigField label={t("prompts.nameLabel")}>
          <input value={nameText} onChange={(e) => setNameText(e.target.value)} style={inputStyle} />
        </ConfigField>
        <ConfigField label={t("prompts.personalityLabel2")}>
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 8px" }}>{t("prompts.personalityHint")}</p>
          <textarea value={personalityText} onChange={(e) => setPersonalityText(e.target.value)} style={textareaStyle} />
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4, fontFamily: "var(--font-mono)" }}>
            {t("prompts.charCount2", { count: personalityText.length.toLocaleString() })}
          </div>
        </ConfigField>
      </ConfigDetail>
    );
  };

  return (
    <ConfigPanelShell embedded={embedded} title={t("prompts.heading")} closeLabel={t("i18n.close")} onClose={onClose ?? (() => {})}>
      <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5, flex: 1, minWidth: 200 }}>{t("prompts.intro")}</p>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-muted)", flexShrink: 0 }} title={t("prompts.injectHint")}>
          <span>{t("prompts.injectModeLabel")}</span>
          <select
            value={injectMode}
            onChange={(e) => void changeInjectMode(e.target.value as "every-turn" | "cached")}
            style={{ height: 30, padding: "0 8px", fontSize: 12, borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)" }}
          >
            <option value="every-turn">{t("prompts.injectEveryTurn")}</option>
            <option value="cached">{t("prompts.injectCached")}</option>
          </select>
        </label>
      </div>
      {error ? <p role="alert" className="settings-general-error" style={{ margin: "8px 16px" }}>{t("prompts.saveFailed")}{error}</p> : null}
      <ConfigSplitView>
        <ConfigSidebar>
          <ConfigSidebarList>
            {loading ? (
              <div style={{ padding: 10, color: "var(--text-dim)", fontSize: 12 }}>{t("prompts.loading")}</div>
            ) : (
              <>
                <ConfigSidebarGroupLabel aside={
                  <ConfigButton size="small" variant="ghost" onClick={() => void createPersona()} disabled={saving}>+ {t("prompts.new")}</ConfigButton>
                }>{t("prompts.groupPersonas")}</ConfigSidebarGroupLabel>
                {personas.length === 0 ? (
                  <div style={{ padding: "6px 10px", color: "var(--text-dim)", fontSize: 12 }}>{t("prompts.emptyList")}</div>
                ) : personas.map((p) => (
                  <ConfigSidebarItem
                    key={p.id}
                    active={selection?.kind === "persona" && selection.id === p.id}
                    onClick={() => setSelection({ kind: "persona", id: p.id })}
                  >
                    <ConfigSidebarText>{p.name}</ConfigSidebarText>
                    {defaultId === p.id && <span style={{ fontSize: 10, color: "var(--accent)" }}>★</span>}
                  </ConfigSidebarItem>
                ))}
                {legacy.trim() ? (
                  <button
                    type="button"
                    onClick={() => void importLegacy()}
                    disabled={saving}
                    style={{ margin: "6px 10px", padding: "5px 8px", fontSize: 11, textAlign: "left", background: "none", border: "1px dashed var(--border)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer" }}
                  >
                    {t("prompts.importLegacy")}
                  </button>
                ) : null}

                <ConfigSidebarGroupLabel>{t("prompts.groupGlobal")}</ConfigSidebarGroupLabel>
                <ConfigSidebarItem active={selection?.kind === "rules"} onClick={() => setSelection({ kind: "rules" })}>
                  <ConfigSidebarText>{t("prompts.rulesNav")}</ConfigSidebarText>
                </ConfigSidebarItem>
                <ConfigSidebarItem active={selection?.kind === "agents"} onClick={() => setSelection({ kind: "agents" })}>
                  <ConfigSidebarText>{t("prompts.agentsNav")}</ConfigSidebarText>
                </ConfigSidebarItem>
              </>
            )}
          </ConfigSidebarList>
        </ConfigSidebar>
        <ConfigDetailStack className="is-fill">
          {detail()}
        </ConfigDetailStack>
      </ConfigSplitView>
    </ConfigPanelShell>
  );
}
