"use client";

import Image from "next/image";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { I18nProvider, useI18n } from "@/hooks/useI18n";
import { safeLoginDestination } from "@/lib/login-destination";

/** A scan lands with `#pair=<secret>`; typing uses the short code. */
function readPairSecret(): string | null {
  const hash = window.location.hash.replace(/^#/, "");
  if (hash) {
    const fromHash = new URLSearchParams(hash).get("pair");
    if (fromHash) return fromHash;
  }
  // Older links put it in the query; still honoured.
  return new URLSearchParams(window.location.search).get("pair");
}

/** Where to go after signing in, ignoring anything that is not this origin. */
function safeDestination(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  return safeLoginDestination(next, window.location.origin);
}

/** Remove the secret from the address bar (and from the `next` destination). */
function withoutSecret(destination: string): string {
  try {
    const url = new URL(destination, window.location.origin);
    url.searchParams.delete("pair");
    url.searchParams.delete("pw");
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return destination;
  }
}

function LoginForm() {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pairAttemptedRef = useRef(false);

  // A scanned QR code lands here with #pair=<secret>: redeem it and continue, so the
  // phone never types anything.
  useEffect(() => {
    const secret = readPairSecret();
    if (!secret || pairAttemptedRef.current) return;
    pairAttemptedRef.current = true;
    setBusy(true);
    (async () => {
      try {
        const response = await fetch("/api/web-auth/pair", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ secret }),
        });
        if (!response.ok) {
          setError(t("auth.pairInvalid"));
          setBusy(false);
          return;
        }
        window.location.replace(withoutSecret(safeDestination()));
      } catch {
        setError(t("auth.loginFailed"));
        setBusy(false);
      }
    })();
  }, [t]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/web-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim(), password: code.trim() }),
      });
      if (!response.ok) {
        setError(
          response.status === 429 ? t("auth.tooManyAttempts")
          : response.status === 401 ? t("auth.invalidCode")
          : t("auth.loginFailed"),
        );
        return;
      }
      window.location.replace(withoutSecret(safeDestination()));
    } catch {
      setError(t("auth.loginFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="web-login-page">
      <div className="web-login-shell">
        <header className="web-login-brand">
          <Image src="/icons/apple-touch-icon.png" width={52} height={52} alt="" priority />
          <div>
            <h1>Pi Web</h1>
            <p>{t("auth.prompt")}</p>
          </div>
        </header>
        <form className="web-login-form" onSubmit={submit}>
          <div className="web-login-composer">
            <label className="web-login-label" htmlFor="web-login-code">{t("auth.code")}</label>
            <input
              id="web-login-code"
              type="text"
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12))}
              placeholder={t("auth.codePlaceholder")}
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              autoFocus
              required
              disabled={busy}
              style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.14em" }}
            />
            <button type="submit" disabled={busy || !code.trim()}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="2" y1="7" x2="11" y2="7" />
                <polyline points="7.5 3 12 7 7.5 11" />
              </svg>
              {busy ? t("auth.loggingIn") : t("auth.logIn")}
            </button>
          </div>
          <p className="web-login-error" role="alert" aria-live="polite">{error}</p>
          <p className="web-login-hint">{t("auth.codeHint")}</p>
        </form>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return <I18nProvider><LoginForm /></I18nProvider>;
}
