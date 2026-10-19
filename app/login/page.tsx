"use client";

import Image from "next/image";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { I18nProvider, useI18n } from "@/hooks/useI18n";
import { safeLoginDestination } from "@/lib/login-destination";

function safeDestination(): string {
  const destination = new URLSearchParams(window.location.search).get("next");
  return safeLoginDestination(destination, window.location.origin);
}

function LoginForm() {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pairAttemptedRef = useRef(false);

  /** The destination without the `pw` secret, so it does not stay in the URL. */
  const withoutPasswordParam = (destination: string): string => {
    try {
      const url = new URL(destination, window.location.origin);
      url.searchParams.delete("pw");
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return destination;
    }
  };

  // Two ways in without typing:
  //   ?pair=<token>  a one-time code (2 minutes) for a guest or a borrowed phone;
  //   ?pw=<password> the remote password itself, so a copied link or QR just opens
  //                  (what DSH does: the link carries it).
  // Both strip the parameter from the address bar once they are used.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const pairToken = params.get("pair");
    const passwordParam = params.get("pw");
    if ((!pairToken && !passwordParam) || pairAttemptedRef.current) return;
    // The pairing token is single-use, so redeem it exactly once even though
    // React StrictMode runs this effect twice in development.
    pairAttemptedRef.current = true;
    setBusy(true);
    (async () => {
      try {
        const response = await fetch(pairToken ? "/api/web-auth/pair" : "/api/web-auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(pairToken ? { token: pairToken } : { password: passwordParam }),
        });
        if (!response.ok) {
          setError(t("auth.pairInvalid"));
          setBusy(false);
          return;
        }
        // A password-carrying link signs in and then drops the secret from the
        // address bar (and from the `next` destination it was folded into).
        const destination = safeDestination();
        window.location.replace(pairToken ? destination : withoutPasswordParam(destination));
      } catch {
        setError(t("auth.loginFailed"));
        setBusy(false);
      }
    })();
  }, [t]);

  const failureMessage = async (response: Response): Promise<string> => {
    if (response.status === 401) return t("auth.invalidPassword");
    if (response.status !== 429) return t("auth.loginFailed");
    const seconds = Number(response.headers.get("retry-after"));
    return t("auth.tooManyAttempts", { seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 1 });
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/web-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        setError(await failureMessage(response));
        return;
      }
      window.location.replace(safeDestination());
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
            <label className="web-login-label" htmlFor="web-login-password">{t("auth.password")}</label>
            <input
              id="web-login-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t("auth.password")}
              autoComplete="current-password"
              autoFocus
              required
              disabled={busy}
            />
            <button type="submit" disabled={busy || !password}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="2" y1="7" x2="11" y2="7" />
                <polyline points="7.5 3 12 7 7.5 11" />
              </svg>
              {busy ? t("auth.loggingIn") : t("auth.logIn")}
            </button>
          </div>
          <p className="web-login-error" role="alert" aria-live="polite">{error}</p>
          <p className="web-login-hint">{t("auth.remoteHint")}</p>
        </form>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return <I18nProvider><LoginForm /></I18nProvider>;
}
