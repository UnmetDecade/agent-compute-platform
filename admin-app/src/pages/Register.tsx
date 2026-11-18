import { useState } from "react";
import { Link } from "react-router-dom";
import { t } from "../i18n";
import { useAuth, strongPassword } from "../auth";
import { errorMessage } from "../live/client";
import { AuthLayout } from "../components/AuthLayout";
import { Button, Callout, Field } from "../components/ui";

export function RegisterPage() {
  const auth = useAuth();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const valid =
    /^[a-zA-Z0-9._-]{3,32}$/.test(username.trim()) &&
    strongPassword(password) &&
    password === confirm;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError("");
    try {
      const out = await auth.register({
        username: username.trim(),
        password,
        ...(displayName.trim() ? { display_name: displayName.trim() } : {}),
      });
      if (out.pending) setPending(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (pending) {
    return (
      <AuthLayout
        title={t("Registration submitted")}
        subtitle={t("This account is waiting for administrator approval. You can sign in once it is approved.")}
        footer={<Link className="link" to="/login">{t("Back to sign in")}</Link>}
      >
        <Callout tone="info">{t("An administrator must enable the account on the Accounts page before it can be used.")}</Callout>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={t("Create account")}
      subtitle={t("The first account becomes the administrator; later accounts need administrator approval and start read-only.")}
      footer={
        <span>
          {t("Already have an account?")}{" "}
          <Link className="link" to="/login">{t("Sign in")}</Link>
        </span>
      }
    >
      <form className="stack" onSubmit={submit}>
        <Field label={t("Username")} hint={t("3–32 characters: letters, digits, dot, underscore or dash")}>
          <input
            className="input"
            value={username}
            autoComplete="username"
            autoFocus
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field label={t("Display name")} hint={t("Optional; defaults to the username")}>
          <input
            className="input"
            value={displayName}
            autoComplete="nickname"
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </Field>
        <Field label={t("Password")} hint={t("Longer than 8 characters, with uppercase, lowercase and a symbol")}>
          <input
            className="input"
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label={t("Confirm password")}>
          <input
            className="input"
            type="password"
            value={confirm}
            autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        {confirm && password !== confirm && <Callout tone="warn">{t("The passwords do not match.")}</Callout>}
        {error && <Callout tone="bad">{error}</Callout>}
        <Button type="submit" variant="primary" disabled={busy || !valid}>
          {busy ? t("Submitting…") : t("Register")}
        </Button>
      </form>
    </AuthLayout>
  );
}
