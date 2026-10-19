"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

export interface PersonaOption {
  id: string;
  name: string;
}

/**
 * A compact persona picker for the composer's control row, placed beside the
 * model selector. Selecting an entry switches only THIS conversation's persona;
 * "No persona" is always first. It mirrors the model selector's popover shape.
 */
export function PersonaSelector({
  personas,
  value,
  onChange,
  disabled = false,
  iconOnly = false,
}: {
  personas: PersonaOption[];
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  /**
   * Icon-only button (used when the composer row is too narrow for a label). The
   * current persona is still reachable through the title/aria-label, and the icon
   * turns accent-coloured while a persona is active.
   */
  iconOnly?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = value ? personas.find((p) => p.id === value) : null;
  const label = current ? current.name : t("persona.none");
  const accessibleLabel = `${t("persona.label")}: ${label}`;
  const filtered = filter.trim()
    ? personas.filter((p) => p.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : personas;

  const choose = (id: string | null) => {
    setOpen(false);
    setFilter("");
    onChange(id);
  };

  return (
    <div ref={rootRef} style={{ position: "relative", minWidth: 0, flexShrink: iconOnly ? 0 : 1 }}>
      <button
        type="button"
        aria-label={accessibleLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        title={accessibleLabel}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setAnchor({ left: rect.left, top: rect.top, width: Math.max(rect.width, 200) });
          setOpen((v) => !v);
        }}
        style={{
          display: "flex", alignItems: "center", justifyContent: iconOnly ? "center" : undefined, gap: 5,
          height: 32, padding: iconOnly ? 0 : "0 8px",
          width: iconOnly ? 32 : undefined, maxWidth: iconOnly ? 32 : 160,
          background: "none", border: "none", borderRadius: 9,
          color: value ? "var(--accent)" : "var(--text-muted)",
          cursor: disabled ? "default" : "pointer", fontSize: 12,
          transition: "background 0.12s, color 0.12s",
        }}
        onMouseEnter={(e) => { if (!disabled) { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = value ? "var(--accent)" : "var(--text)"; } }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = value ? "var(--accent)" : "var(--text-muted)"; }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 20c0-4 4-6 8-6s8 2 8 6" />
        </svg>
        {!iconOnly && (
          <>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-dim)" }}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </>
        )}
      </button>

      {open && anchor && (
        <div
          ref={panelRef}
          role="listbox"
          style={{
            position: "fixed",
            left: anchor.left,
            bottom: window.innerHeight - anchor.top + 6,
            zIndex: 200,
            width: Math.min(280, Math.max(anchor.width, 200)),
            maxHeight: "min(60vh, 420px)",
            display: "flex", flexDirection: "column",
            background: "var(--bg)", border: "1px solid var(--border)",
            borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.14)", overflow: "hidden",
          }}
        >
          {personas.length > 8 && (
            <div style={{ padding: 6, borderBottom: "1px solid var(--border)" }}>
              <input
                autoFocus
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={t("persona.filter")}
                style={{ width: "100%", height: 28, padding: "0 8px", fontSize: 12, borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text)", boxSizing: "border-box" }}
              />
            </div>
          )}
          <div style={{ overflowY: "auto", padding: 4 }}>
            <button
              type="button"
              role="option"
              aria-selected={value === null}
              onClick={() => choose(null)}
              style={{
                width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
                padding: "7px 8px", border: "none", borderRadius: 6, cursor: "pointer", textAlign: "left",
                background: value === null ? "var(--bg-selected)" : "none", color: "var(--text)", fontSize: 12.5,
              }}
            >
              <span>{t("persona.none")}</span>
              {value === null && <span style={{ color: "var(--accent)" }}>✓</span>}
            </button>
            {filtered.map((p) => (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={value === p.id}
                onClick={() => choose(p.id)}
                style={{
                  width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
                  padding: "7px 8px", border: "none", borderRadius: 6, cursor: "pointer", textAlign: "left",
                  background: value === p.id ? "var(--bg-selected)" : "none", color: "var(--text)", fontSize: 12.5,
                }}
              >
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                {value === p.id && <span style={{ color: "var(--accent)" }}>✓</span>}
              </button>
            ))}
            {filtered.length === 0 && (
              <div style={{ padding: "8px", fontSize: 12, color: "var(--text-dim)" }}>{t("persona.empty")}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
