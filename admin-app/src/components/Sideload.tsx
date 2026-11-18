import { useId, useState } from "react";
import { t } from "../i18n";
import { errorMessage } from "../live/client";
import { createSideload, deleteSideload } from "../api";
import type { Host, Sideload, SideloadScope } from "../types";
import { Badge, Button, Callout, Field, Modal, Tag } from "./ui";

/**
 * Side-load cards and dialogs.
 *
 * A sideload is not an Agent: it is a device on the LAN holding a curl token for this host. So instead of a robot
 * it gets a host cartoon, and instead of a scheduler tree edge it sits beside the root scheduler card.
 */

export type SideloadState = "online" | "offline" | "expired";

/** Online means "called us in the last two minutes"; revocation and expiry win over presence. */
export function sideloadState(s: Sideload, now = Date.now()): SideloadState {
  if (s.revoked_at) return "expired";
  if (s.expires_at && new Date(s.expires_at).getTime() <= now) return "expired";
  if (s.last_seen_at && now - new Date(s.last_seen_at).getTime() < 120_000) return "online";
  return "offline";
}

const SCOPE_SHORT: Record<SideloadScope, string> = {
  "tasks:read": "Read tasks",
  "tasks:write": "Write tasks",
  "builders:read": "View builders",
  "queue:read": "View queue",
  "console:run": "Run commands",
};

const SCOPE_DESC: Record<SideloadScope, string> = {
  "tasks:read": "List tasks, read task details and the event stream",
  "tasks:write": "Create, cancel and retry tasks, and answer an Agent's question",
  "builders:read": "List this host's builders and their load",
  "queue:read": "Read queue length, wait time and dispatch statistics",
  "console:run": "Run shell commands on this host's builders (dangerous; also needs Write tasks)",
};

export const SIDELOAD_SCOPES: SideloadScope[] = [
  "tasks:read",
  "tasks:write",
  "builders:read",
  "queue:read",
  "console:run",
];

function scopeShort(scope: SideloadScope): string {
  return t(SCOPE_SHORT[scope] ?? scope);
}

function stateText(state: SideloadState): string {
  if (state === "online") return t("Online");
  if (state === "expired") return t("Expired");
  return t("Offline");
}

function stateBadge(state: SideloadState): string {
  if (state === "online") return "ONLINE";
  if (state === "expired") return "EXPIRED";
  return "OFFLINE";
}

/**
 * Host cartoon: a small rack/desktop box with a screen face, status LED and Wi-Fi arcs.
 * Drawn in the same hand-drawn language as the robots, but it is clearly a machine, not an Agent.
 */
export function SideloadHostArt({ state, size = 60 }: { state: SideloadState; size?: number }) {
  const raw = useId();
  const id = `host-${raw.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const live = state === "online";
  const dead = state === "expired";
  const shell = dead ? "#8a93a0" : "#5b7fa6";
  const accent = dead ? "#5d6673" : "#34526f";
  const screen = "#182230";
  const led = dead ? "#c26b6b" : live ? "#7dd3a0" : "#6c7a8c";
  const eye = dead ? "#6c7a8c" : live ? "#9fe8c1" : "#8a97a6";

  return (
    <svg
      className={`character host-art ch-${state === "online" ? "working" : state === "offline" ? "rest" : "offline"}`}
      width={size}
      height={size}
      viewBox="0 0 96 96"
      role="img"
      aria-label={`${t("Sideload host")} · ${stateText(state)}`}
    >
      <defs>
        <linearGradient id={`${id}-shell`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={shell} />
          <stop offset="1" stopColor={accent} />
        </linearGradient>
      </defs>

      <circle cx="48" cy="48" r="44" fill={shell} fillOpacity="0.12" />

      <g className="ch-breath">
        {live && (
          <g className="host-wifi" stroke={led} strokeWidth="1.6" strokeLinecap="round" fill="none" opacity="0.75">
            <path d="M39 22a13 13 0 0 1 18 0" />
            <path d="M43 26a7 7 0 0 1 10 0" />
            <circle cx="48" cy="30" r="1.6" fill={led} stroke="none" />
          </g>
        )}

        {/* Feet */}
        <rect x="30" y="70" width="9" height="7" rx="3" fill={accent} />
        <rect x="57" y="70" width="9" height="7" rx="3" fill={accent} />

        {/* Case */}
        <rect x="21" y="33" width="54" height="37" rx="9" fill={`url(#${id}-shell)`} />
        <rect x="27" y="38" width="42" height="22" rx="5" fill={screen} />
        <path d="M29 38c0-2.6 2.1-4.7 4.7-4.7h28.6c2.6 0 4.7 2.1 4.7 4.7" fill={accent} fillOpacity="0.35" />

        {dead || state === "offline" ? (
          <g stroke={eye} strokeWidth="1.7" strokeLinecap="round" fill="none">
            <path d="M35.5 49.5q2.8 2.2 5.6 0" />
            <path d="M48.5 49.5q2.8 2.2 5.6 0" />
          </g>
        ) : (
          <g className="host-eyes" fill={eye}>
            <rect x="35" y="46" width="6.5" height="6.5" rx="2.6" />
            <rect x="48" y="46" width="6.5" height="6.5" rx="2.6" />
            <rect x="36.4" y="47.2" width="2" height="2" rx="0.7" fill="#fff" fillOpacity="0.8" />
            <rect x="49.4" y="47.2" width="2" height="2" rx="0.7" fill="#fff" fillOpacity="0.8" />
          </g>
        )}
        <path d="M41 55q4 2.6 8 0" fill="none" stroke={eye} strokeWidth="1.6" strokeLinecap="round" opacity="0.8" />

        {/* Vents and the status LED on the case */}
        <rect x="28" y="64" width="18" height="2.2" rx="1.1" fill={accent} fillOpacity="0.55" />
        <rect x="28" y="68" width="12" height="2.2" rx="1.1" fill={accent} fillOpacity="0.4" />
        <circle
          cx="66"
          cy="66"
          r="3"
          fill={led}
          className={live ? "host-led" : undefined}
          fillOpacity={dead ? 0.85 : 1}
        />
      </g>

      {state === "expired" && (
        <g className="ch-alert-badge">
          <circle cx="76" cy="20" r="8" fill="#c23b3b" />
          <path d="M76 15.5v5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="76" cy="24" r="1" fill="#fff" />
        </g>
      )}
      {state === "offline" && (
        <g className="ch-zzz" fill={led} fillOpacity="0.65" fontSize="8" fontWeight="600">
          <text x="72" y="26">z</text>
          <text x="78" y="20">z</text>
        </g>
      )}
    </svg>
  );
}

/** One created sideload, sitting beside the root scheduler card. */
export function SideloadLeaf({
  sideload,
  onOpen,
  nodeRef,
}: {
  sideload: Sideload;
  onOpen: (s: Sideload) => void;
  /** The scene registers the card element so it can draw a line from the root scheduler. */
  nodeRef?: (el: HTMLElement | null) => void;
}) {
  const state = sideloadState(sideload);
  return (
    <button
      ref={nodeRef}
      type="button"
      className={`scene-sideload is-${state}`}
      onClick={() => onOpen(sideload)}
      title={t("View this sideload's permissions and curl examples")}
    >
      <div className="scene-node-head">
        <span className="scene-node-title">{t("Sideload")}</span>
        <Badge value={stateBadge(state)} text={stateText(state)} />
      </div>
      <SideloadHostArt state={state} size={60} />
      <b className="scene-node-name">{sideload.name}</b>
      <small className="scene-sideload-token">sdl_…{sideload.token_hint}</small>
      <div className="chips">
        {sideload.scopes.slice(0, 2).map((scope) => (
          <Tag key={scope} tone={scope === "console:run" ? "warn" : "neutral"}>
            {scopeShort(scope)}
          </Tag>
        ))}
        {sideload.scopes.length > 2 && <Tag>+{sideload.scopes.length - 2}</Tag>}
      </div>
    </button>
  );
}

/** Dashed "attach a sideload" card at the end of the strip; the scene links it like any other card, statically. */
export function SideloadAddCard({
  onClick,
  nodeRef,
}: {
  onClick: () => void;
  nodeRef?: (el: HTMLElement | null) => void;
}) {
  return (
    <button
      ref={nodeRef}
      type="button"
      className="scene-sideload is-add"
      onClick={onClick}
      title={t("Send a curl token to a LAN device")}
    >
      <span className="empty-plus">＋</span>
      <b>{t("Attach sideload")}</b>
      <small>{t("Call this host's compute with curl")}</small>
    </button>
  );
}

/** Copy-to-clipboard helper with an inline "copied" state. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="link"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          window.setTimeout(() => setDone(false), 1600);
        } catch {
          // Clipboard is unavailable outside a secure context; the text stays selectable.
        }
      }}
    >
      {done ? t("Copied") : label}
    </button>
  );
}

export function CreateSideloadModal({
  host,
  onClose,
  onCreated,
}: {
  host: Host;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Set<SideloadScope>>(
    () => new Set<SideloadScope>(["tasks:read", "tasks:write", "builders:read"]),
  );
  const [expiry, setExpiry] = useState("30");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{
    sideload: Sideload;
    token: string;
    base_url: string;
  } | null>(null);

  function toggle(scope: SideloadScope) {
    setScopes((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) {
        next.delete(scope);
        // console:run is meaningless without the write path it rides on.
        if (scope === "tasks:write") next.delete("console:run");
      } else {
        next.add(scope);
        if (scope === "console:run") next.add("tasks:write");
      }
      return next;
    });
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const out = await createSideload({
        hostId: host.id,
        name: name.trim() || `${host.name} · curl`,
        scopes: [...scopes],
        ...(expiry ? { expiresInDays: Number(expiry) } : {}),
      });
      setCreated(out);
      await onCreated();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <Modal
        open
        title={t("Sideload created")}
        onClose={onClose}
        width={640}
        footer={<Button variant="primary" onClick={onClose}>{t("Done")}</Button>}
      >
        <div className="stack">
          <Callout tone="warn">
            {t("The token is shown only once. It cannot be looked up after this window closes; if it is lost, delete it and create a new one.")}
          </Callout>
          <Field label={t("Token")} hint={t("Send it as a header: authorization: Bearer <token>")}>
            <div className="sideload-token-row">
              <code className="code-block">{created.token}</code>
              <CopyButton text={created.token} label={t("Copy token")} />
            </div>
          </Field>
          <div className="sideload-copy-row">
            <span>{t("Control plane: {url}", { url: created.base_url })}</span>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      title={t("Attach sideload")}
      onClose={onClose}
      width={600}
      footer={
        <>
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={busy || scopes.size === 0 || !name.trim()}
          >
            {busy ? t("Creating…") : t("Create token")}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Callout>
          {t("A sideload is a curl token for a chosen device on the LAN: it sees only the host \"{host}\" and never another host's sideloads.", {
            host: host.name,
          })}
        </Callout>
        <Field label={t("Name")} hint={t("e.g. laptop, test box, CI container")}>
          <input
            className="input"
            value={name}
            maxLength={64}
            placeholder={t("Who is using this token")}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <div className="field">
          <span className="field-label">{t("Permissions")}</span>
          <div className="stack">
            {SIDELOAD_SCOPES.map((scope) => {
              const checked = scopes.has(scope);
              return (
                <label key={scope} className={`check-row${checked ? " checked" : ""}`}>
                  <input type="checkbox" checked={checked} onChange={() => toggle(scope)} />
                  <div>
                    <b>{scopeShort(scope)}</b>
                    <p className="field-hint">{t(SCOPE_DESC[scope])}</p>
                  </div>
                  <Tag tone={scope === "console:run" ? "warn" : "neutral"}>{scope}</Tag>
                </label>
              );
            })}
          </div>
          <span className="field-hint">{t("Permissions are a closed set; Run commands also requires Write tasks.")}</span>
        </div>
        <Field label={t("Expires")}>
          <select className="input" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
            <option value="7">{t("7 days")}</option>
            <option value="30">{t("30 days")}</option>
            <option value="90">{t("90 days")}</option>
            <option value="">{t("Never")}</option>
          </select>
        </Field>
        {error && <Callout tone="bad">{error}</Callout>}
      </div>
    </Modal>
  );
}

export function SideloadDetailModal({
  sideload,
  hostName,
  onClose,
  onDeleted,
}: {
  sideload: Sideload;
  hostName: string;
  onClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const state = sideloadState(sideload);

  async function remove() {
    setBusy(true);
    setError("");
    try {
      await deleteSideload(sideload.sideload_id);
      await onDeleted();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title={t("Sideload · {name}", { name: sideload.name })}
      onClose={onClose}
      width={620}
      footer={
        <>
          <Button onClick={onClose}>{t("Close")}</Button>
          <Button
            variant="danger"
            onClick={() => (confirming ? remove() : setConfirming(true))}
            disabled={busy}
          >
            {busy ? t("Deleting…") : confirming ? t("Confirm delete") : t("Delete sideload")}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="sideload-detail-head">
          <SideloadHostArt state={state} size={64} />
          <div>
            <b>{sideload.name}</b>
            <p>
              {hostName} · sdl_…{sideload.token_hint}
            </p>
            <div className="chips">
              <Badge value={stateBadge(state)} text={stateText(state)} />
              {sideload.scopes.map((scope) => (
                <Tag key={scope} tone={scope === "console:run" ? "warn" : "neutral"}>
                  {scopeShort(scope)}
                </Tag>
              ))}
            </div>
          </div>
        </div>

        <div className="sideload-meta">
          <span>{t("Created: {time}", { time: formatTime(sideload.created_at) })}</span>
          <span>{t("Last call: {time}", { time: sideload.last_seen_at ? formatTime(sideload.last_seen_at) : t("never") })}</span>
          <span>{t("Expires: {time}", { time: sideload.expires_at ? formatTime(sideload.expires_at) : t("Never") })}</span>
          {sideload.last_ip && <span>{t("Source address: {ip}", { ip: sideload.last_ip })}</span>}
        </div>

        {confirming && (
          <Callout tone="bad">
            {t("The token stops working immediately after deletion; the device using it receives 403.")}
          </Callout>
        )}
        {error && <Callout tone="bad">{error}</Callout>}

        <div className="sideload-copy-row">
          <span>{t("Every call is checked against the token's permissions; a missing permission returns 403.")}</span>
        </div>
      </div>
    </Modal>
  );
}

function formatTime(value: string): string {
  if (!value) return "-";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}
