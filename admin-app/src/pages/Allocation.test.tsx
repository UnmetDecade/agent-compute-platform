import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { db } from "../store";
import type { Instance } from "../types";
import { parsePlanDocument, summarizeRule, type PlanRule } from "../live/roles";
import { PlansPage } from "./Plans";
import { RolesPage } from "./Roles";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function stubFetch(handler: Handler) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init ?? {}),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

/** Only a builder can receive business roles; the page lists builders from the live snapshot. */
function builder(overrides: Partial<Instance> = {}): Instance {
  return {
    key: "h1::dev-a",
    id: "dev-a",
    name: "dev-a",
    role: "builder",
    host_id: "h1",
    agent_profile_id: "agp_builder",
    api_profile_ids: [],
    task_types: ["task.build"],
    resource_profile: "p1",
    cpu_limit: 1,
    mem_limit_mb: 3072,
    disk_gb: 10,
    state: "ONLINE",
    config_version: 1,
    last_heartbeat: "2026-01-01T00:00:00Z",
    image: "platform/builder:roles",
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const role = {
  role_key: "ui-dev",
  project: "demo",
  name: "UI developer",
  description: "UI development",
  operation_prompt: "Only edit files under ui/.",
  required_capabilities: ["repo:read"],
  allowed_paths: ["ui/"],
  workdir_template: "/work/{project}/work/{role}",
  enabled: true,
  instances_total: 1,
  instances_online: 1,
};

const document = {
  rules: [
    {
      id: "ui",
      priority: 20,
      match: { category: ["ui"] },
      role: "ui-dev",
      chain: [
        { role: "code-review", build: { mode: "command", command: "bash review.sh" } },
      ],
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  db.instances = [];
  db.hosts = [];
});

describe("RolesPage", () => {
  it("shows coverage and the roles assigned to each builder", async () => {
    db.instances = [builder()];
    stubFetch((url) => {
      if (url.endsWith("/v1/business-roles")) return json({ items: [role] });
      if (url.endsWith("/v1/instances/dev-a/roles")) {
        return json({ items: [{ role_key: "ui-dev", weight: 100, name: "UI developer" }] });
      }
      return json({ items: [] });
    });

    render(
      <I18nProvider>
        <RolesPage />
      </I18nProvider>,
    );

    // The role name appears both in the definition table and as the builder's assignment tag.
    expect((await screen.findAllByText("UI developer")).length).toBeGreaterThan(0);
    // Coverage is the operator's early warning: a role with no online machine stalls its queue.
    expect(screen.getByText("1/1")).toBeInTheDocument();
    expect(screen.getByText("dev-a")).toBeInTheDocument();
    expect(screen.getByTitle("Weight 100")).toBeInTheDocument();
  });

  it("creates a role through the scheduler API", async () => {
    db.instances = [];
    const fetchMock = stubFetch((url, init) => {
      if (url.endsWith("/v1/business-roles") && init.method === "POST") {
        return json({ ...role, role_key: "driver-dev" });
      }
      return json({ items: [] });
    });

    render(
      <I18nProvider>
        <RolesPage />
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByText("New role"));
    fireEvent.change(screen.getByPlaceholderText("e.g. UI development"), {
      target: { value: "Driver development" },
    });
    fireEvent.change(screen.getByPlaceholderText("demo"), { target: { value: "demo" } });
    fireEvent.change(
      screen.getByPlaceholderText(
        "e.g. only edit files under ui/, run repo/smoke.sh when done, and write the result in the summary.",
      ),
      { target: { value: "Only edit files under drivers/; run smoke.sh when done." } },
    );
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const post = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith("/v1/business-roles") && init?.method === "POST",
    );
    expect(post).toBeTruthy();
    const body = bodyOf(post![1] as RequestInit);
    // The console sends only what the operator typed; the scheduler derives the key
    // and defaults the workdir.
    expect(body.role_key).toBeUndefined();
    expect(body.project).toBe("demo");
    expect(body.name).toBe("Driver development");
    expect(body.operation_prompt).toBe("Only edit files under drivers/; run smoke.sh when done.");
    expect(body.required_capabilities).toBeUndefined();
  });
});

describe("PlansPage", () => {
  it("opens a plan and shows the rules it compiled into", async () => {
    stubFetch((url) => {
      if (url.includes("/v1/plans/p1")) {
        return json({
          plan_id: "p1",
          project: "demo",
          name: "demo plan",
          version: 2,
          status: "ACTIVE",
          document,
          document_text: "UI requests go to UI development, then review.",
          rule_count: 1,
          updated_at: "2026-01-01T00:00:00Z",
        });
      }
      if (url.includes("/v1/plans")) {
        return json({
          items: [
            {
              plan_id: "p1",
              project: "demo",
              name: "demo plan",
              version: 2,
              status: "ACTIVE",
              rule_count: 1,
              updated_at: "2026-01-01T00:00:00Z",
            },
          ],
        });
      }
      return json({});
    });

    render(
      <I18nProvider>
        <PlansPage />
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByText("demo plan"));
    // The editor loads the operator's prose and the rules it compiled into.
    expect(await screen.findByText("Plan description")).toBeInTheDocument();
    expect(screen.getByDisplayValue("UI requests go to UI development, then review.")).toBeInTheDocument();
    expect(screen.getByText("Rules the scheduler will run")).toBeInTheDocument();
  });
});

describe("plan document helpers", () => {
  it("rejects documents the scheduler would reject", () => {
    expect(() => parsePlanDocument("{")).toThrow(/JSON/);
    expect(() => parsePlanDocument('{"rules":[]}')).toThrow(/non-empty/);
    expect(() => parsePlanDocument('{"rules":{}}')).toThrow(/non-empty/);
  });

  it("summarizes match keys and the chain for the editor preview", () => {
    const summary = summarizeRule(document.rules[0] as unknown as PlanRule);
    expect(summary.match).toBe("category=ui");
    expect(summary.chain).toEqual(["ui-dev", "code-review"]);

    const fallback = summarizeRule({ id: "fallback", role: "driver-dev", match: { any: true } });
    expect(fallback.match).toBe("any");
    expect(fallback.chain).toEqual(["driver-dev"]);
  });
});
