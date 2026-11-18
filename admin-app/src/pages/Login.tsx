import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { t } from "../i18n";
import { useAuth } from "../auth";
import { getLiveConnection } from "../live/config";
import { errorMessage } from "../live/client";
import { AuthLayout } from "../components/AuthLayout";
import { Button, Callout, Field, Modal } from "../components/ui";

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [demo, setDemo] = useState(false);
  const [firstRun, setFirstRun] = useState(false);

  // The demo seeds admin/admin and prefills it here; a normal deployment with no
  // accounts yet opens the first-run hint and points at registration.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${getLiveConnection().pcsUrl}/api/v1/auth/config`, {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!res.ok) return;
        const out = (await res.json()) as { demo?: boolean; has_accounts?: boolean };
        if (cancelled) return;
        if (out.demo) {
          setUsername("admin");
          setPassword("admin");
          setDemo(true);
          return;
        }
        if (out.has_accounts === false) setFirstRun(true);
      } catch {
        // No config endpoint (older PCS) or offline: keep the form empty.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setBusy(true);
    setError("");
    try {
      await auth.login(username.trim(), password);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <AuthLayout
        title={t("Sign in")}
        subtitle={t("Reach the console only over the LAN or a VPN; for public access use sideload tokens instead.")}
        footer={
          <span>
            {t("No account yet?")}{" "}
            <Link className="link" to="/register">{t("Register")}</Link>
          </span>
        }
      >
        <form className="stack" onSubmit={submit}>
          <Field label={t("Username")}>
            <input
              className="input"
              value={username}
              autoComplete="username"
              autoFocus
              onChange={(e) => setUsername(e.target.value)}
            />
          </Field>
          <Field label={t("Password")}>
            <input
              className="input"
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {demo && <Callout tone="info">{t("Demo mode prefilled the default account admin / admin.")}</Callout>}
          {error && <Callout tone="bad">{error}</Callout>}
          <Button type="submit" variant="primary" disabled={busy || !username.trim() || !password}>
            {busy ? t("Signing in…") : t("Sign in")}
          </Button>
        </form>
      </AuthLayout>

      <Modal
        open={firstRun}
        title={t("First-time setup")}
        onClose={() => setFirstRun(false)}
        width={460}
        footer={
          <>
            <Button onClick={() => setFirstRun(false)}>{t("Later")}</Button>
            <Button variant="primary" onClick={() => navigate("/register")}>{t("Register")}</Button>
          </>
        }
      >
        <div className="stack">
          <p>{t("This deployment has no accounts yet.")}</p>
          <p>{t("Use Register at the bottom of the sign-in page to create the first account; it becomes the administrator and signs in automatically.")}</p>
          <p>{t("Later registrations stay pending until an administrator approves them.")}</p>
          <div className="muted">{t("The password must be longer than 8 characters and include an uppercase letter, a lowercase letter and a symbol.")}</div>
        </div>
      </Modal>
    </>
  );
}
