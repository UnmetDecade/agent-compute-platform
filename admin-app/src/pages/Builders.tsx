import { t } from "../i18n";
import { useState } from "react";
import { Link } from "react-router-dom";
import { db } from "../store";
import { useHostScope } from "../host-context";
import { groupByHost, hostTreeIds } from "../host-tree";
import type { Instance } from "../types";
import { characterState } from "../characters";
import { Character } from "../components/Character";
import { HostFold } from "../components/HostFold";
import { Badge, Card, Empty, PageHead, Tag } from "../components/ui";
import { Icon } from "../components/Icon";
import { osLabel } from "../api";

export function Builders() {
  const { host } = useHostScope();
  const [query, setQuery] = useState("");
  const [state, setState] = useState("ALL");

  // Like the scheduler page, scope to the host subtree: builders on hosts folded into this one are listed too.
  const scopedHostIds = hostTreeIds(host?.id);
  const builders = db.instances.filter(
    (i) => i.role === "builder" && (!host || scopedHostIds.has(i.host_id)),
  );
  const shown = builders.filter((b) => {
    if (state !== "ALL" && b.state !== state) return false;
    const q = query.trim().toLowerCase();
    return !q || b.name.toLowerCase().includes(q) || (b.os ?? "").includes(q);
  });
  // One group per host, collapsed by host name; the local host is expanded by default and folded hosts are collapsed.
  const groups = groupByHost(shown, host?.id);
  const filtering = query.trim() !== "" || state !== "ALL";

  return (
    <div className="page">
      <PageHead
        title={t("Builders")}
        meta={
          <>
            <span>{host?.name ?? t("No host selected")}</span>
            <span className="sep" />
            <span>{t("{count} units", { count: builders.length })}</span>
            <span className="sep" />
            <span>{t("{count} online", { count: builders.filter((b) => b.state === "ONLINE").length })}</span>
          </>
        }
      />

      <div className="toolbar">
        <div className="search">
          <Icon name="search" size={14} />
          <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("Search by name or OS")} />
        </div>
        <div className="segmented">
          {["ALL", "ONLINE", "SUSPECT", "OFFLINE"].map((s) => (
            <button key={s} className={`segment${state === s ? " active" : ""}`} onClick={() => setState(s)}>
              {s === "ALL" ? t("All") : s}
              <em>{s === "ALL" ? builders.length : builders.filter((b) => b.state === s).length}</em>
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <Card><Empty text={host ? t("No matching builders on {host} yet.", { host: host.name }) : t("Add a host first.")} /></Card>
      ) : (
        <Card flush>
          <div className="list">
            {groups.length > 1 ? (
              groups.map((g) => (
                <HostFold
                  key={g.hostId}
                  name={g.name}
                  label={t("{count} units", { count: g.items.length })}
                  foldKey={`builders:${g.hostId}`}
                  defaultOpen={g.current}
                  forceOpen={filtering}
                >
                  {g.items.map((b) => (
                    <BuilderRow key={b.key} builder={b} />
                  ))}
                </HostFold>
              ))
            ) : (
              // With only one host (no folded hosts), no collapsing is needed; the list is laid out flat.
              groups[0]?.items.map((b) => <BuilderRow key={b.key} builder={b} />)
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

function BuilderRow({ builder }: { builder: Instance }) {
  const running = db.tasks.find((t) => t.instance_id === builder.id && t.state === "RUNNING");
  const agent = db.agents.find((a) => a.id === builder.agent_profile_id);
  // The builder registers with a specific scheduler; legacy data without scheduler_id falls back to the local root scheduler.
  const hostRoot = db.instances.find(
    (i) =>
      i.role === "scheduler" &&
      i.host_id === builder.host_id &&
      (i.scheduler_role ?? "root") === "root",
  );
  // Attribute by instance name, so it still matches when a scheduler restart changes the deployment_id.
  // A bare-metal builder may attach to a scheduler on another host, so the id lookup must not be limited to its own.
  const scheduler = db.instances.find(
    (i) => i.role === "scheduler" && i.id === (builder.scheduler_instance_id ?? hostRoot?.id),
  );
  return (
    <div className="list-row">
      <Character role="builder" state={characterState(builder, running)} size={32} flat />
      <div className="list-main">
        <div className="list-title">
          <Link className="strong" to={`/builders/${builder.id}`}>{builder.name}</Link>
          <Badge value={builder.state} />
          {builder.capability_score !== undefined && (
            <Tag tone="accent" title={t("Work capacity: gates task difficulty and prefers stronger idle builders inside the same business role")}>
              W {builder.capability_score}
            </Tag>
          )}
        </div>
        <div className="list-meta">
          <span>{osLabel(builder.os)}</span>
          <span>{t("Config v{version}", { version: builder.config_version })}</span>
          <span>{scheduler ? `→ ${scheduler.name}` : t("No scheduler")}</span>
          <span>{agent?.name ?? t("No Agent")}</span>
          <span>{builder.cpu_limit}C / {Math.round(builder.mem_limit_mb / 1024)}G / {builder.disk_gb}G</span>
          {builder.ssh_port && <code>ssh :{builder.ssh_port}</code>}
          <span className="sep" />
          {running ? (
            <span className="list-live"><span className="dot dot-ok" />{running.title}</span>
          ) : (
            <span>{t("Idle")}</span>
          )}
        </div>
      </div>
    </div>
  );
}
