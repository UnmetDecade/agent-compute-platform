import { t } from "../i18n";
import { db } from "../store";
import { useLive } from "../live/context";
import { Badge, Card, Empty, PageHead } from "../components/ui";

/**
 * Logs: operation records from the scheduler and control plane.
 * Data comes from control plane audit logs.
 */
export function LogsPage() {
  // A direct visit renders before the first sync; subscribing re-renders once the audit rows arrive
  // instead of leaving "no logs yet" on screen.
  useLive();
  const logs = db.logs;
  return (
    <div className="page page-logs">
      <PageHead
        title={t("Logs")}
        meta={
          <>
            <span>{t("{count} entries", { count: logs.length })}</span>
            <span className="sep" />
            <span>{t("Scheduler & control plane")}</span>
          </>
        }
      />

      <Card flush>
        {logs.length === 0 ? (
          <Empty text={t("No logs yet.")} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t("Time")}</th>
                <th>{t("Actor")}</th>
                <th>{t("Action")}</th>
                <th>{t("Object")}</th>
                <th>{t("Result")}</th>
                <th>{t("Details")}</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id}>
                  <td className="muted small">{new Date(l.at).toLocaleString()}</td>
                  <td>{l.actor || "-"}</td>
                  <td><code>{l.action}</code></td>
                  <td>{l.object}</td>
                  <td><Badge value={l.result === "OK" ? "SUCCEEDED" : "FAILED"} /></td>
                  <td className="muted small">{l.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
