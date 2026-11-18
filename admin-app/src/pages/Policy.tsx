import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { t } from "../i18n";
import { useAuth } from "../auth";
import { getLiveConnection } from "../live/config";
import { errorMessage, pcs } from "../live/client";
import type { Mandate, PolicyDocument } from "../types";
import { Callout, Card, CardTitle, Empty, PageHead, Tag } from "../components/ui";

/**
 * Admission policy and the mandates issued under it.
 *
 * The policy is versioned in the control plane; each task carries an immutable mandate
 * (source, actor, policy version, strength) that explains why it was authorized.
 */
export function PolicyPage() {
  const auth = useAuth();
  const [policy, setPolicy] = useState<{ version: string; document: PolicyDocument } | null>(null);
  const [mandates, setMandates] = useState<Mandate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [policyOut, mandatesOut] = await Promise.all([
        pcs<{ version: string; document: PolicyDocument }>(getLiveConnection(), "/api/v1/platform/policy"),
        pcs<{ mandates: Mandate[] }>(getLiveConnection(), "/api/v1/platform/mandates?limit=100"),
      ]);
      setPolicy(policyOut);
      setMandates(mandatesOut.mandates ?? []);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const canRead = auth.hasScope("audit:read");

  useEffect(() => {
    if (canRead) void load();
    else setLoading(false);
  }, [canRead, load]);

  if (!canRead) {
    return (
      <div className="page">
        <PageHead title={t("Policy")} />
        <Callout tone="warn">{t("This account cannot view the policy.")}</Callout>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHead
        title={t("Policy")}
        meta={
          <>
            {policy ? <Tag>{t("policy v{version}", { version: policy.version })}</Tag> : null}
            <span className="sep" />
            <span>{t("{count} authorizations", { count: mandates.length })}</span>
          </>
        }
      />

      {error && <Callout tone="bad">{error}</Callout>}

      <Card>
        <CardTitle>{t("Policy and authorizations")}</CardTitle>
        <div className="muted" style={{ marginBottom: 10 }}>
          {t("Admission rules by source and the most recent authorizations.")}
        </div>
        {loading ? (
          <Empty text={t("Loading…")} />
        ) : mandates.length === 0 ? (
          <Empty text={t("No authorizations recorded yet.")} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("Time")}</th>
                  <th>{t("Actor")}</th>
                  <th>{t("Source")}</th>
                  <th>{t("Strength")}</th>
                  <th>{t("Tasks")}</th>
                  <th>{t("Policy")}</th>
                </tr>
              </thead>
              <tbody>
                {mandates.map((m) => (
                  <tr key={m.mandate_id}>
                    <td className="muted small">{new Date(m.issued_at).toLocaleString()}</td>
                    <td>{m.actor}</td>
                    <td><Tag>{m.source}</Tag></td>
                    <td>{m.strength === "explicit" ? t("Explicit") : t("Inferred")}</td>
                    <td>
                      {m.task_id ? (
                        <Link className="link" to={`/tasks/${m.task_id}`}>{m.task_id}</Link>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td>v{m.policy_version}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
