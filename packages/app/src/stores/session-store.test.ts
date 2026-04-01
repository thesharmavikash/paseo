import { afterEach, describe, expect, it } from "vitest";
import type { DaemonClient } from "@server/client/daemon-client";
import type { WorkspaceDescriptorPayload } from "@server/shared/messages";
import {
  normalizeWorkspaceDescriptor,
  useSessionStore,
  type WorkspaceDescriptor,
} from "./session-store";

function workspace(
  input: Partial<WorkspaceDescriptor> & Pick<WorkspaceDescriptor, "id">,
): WorkspaceDescriptor {
  return {
    id: input.id,
    projectId: input.projectId ?? "project-1",
    projectDisplayName: input.projectDisplayName ?? "Project 1",
    projectRootPath: input.projectRootPath ?? "/repo",
    projectKind: input.projectKind ?? "git",
    workspaceKind: input.workspaceKind ?? "local_checkout",
    name: input.name ?? "main",
    status: input.status ?? "done",
    activityAt: input.activityAt ?? null,
    diffStat: input.diffStat ?? null,
    services: input.services ?? [],
  };
}

afterEach(() => {
  useSessionStore.getState().clearSession("test-server");
});

describe("normalizeWorkspaceDescriptor", () => {
  it("normalizes workspace services and invalid activity timestamps", () => {
    const services = [
      {
        serviceName: "web",
        hostname: "main.web.localhost",
        port: 3000,
        url: "http://main.web.localhost:6767",
        status: "running" as const,
      },
    ];
    const workspace = normalizeWorkspaceDescriptor({
      id: "/repo/main",
      projectId: "project-1",
      projectDisplayName: "Project 1",
      projectRootPath: "/repo",
      projectKind: "git",
      workspaceKind: "local_checkout",
      name: "main",
      status: "running",
      activityAt: "not-a-date",
      diffStat: null,
      services,
    });

    expect(workspace.activityAt).toBeNull();
    expect(workspace.services).toEqual([
      {
        serviceName: "web",
        hostname: "main.web.localhost",
        port: 3000,
        url: "http://main.web.localhost:6767",
        status: "running",
      },
    ]);
    expect(workspace.services).not.toBe(services);
  });

  it("defaults missing services to an empty array", () => {
    const payload = {
      id: "/repo/main",
      projectId: "project-1",
      projectDisplayName: "Project 1",
      projectRootPath: "/repo",
      projectKind: "git",
      workspaceKind: "local_checkout",
      name: "main",
      status: "done",
      activityAt: null,
      diffStat: null,
    } as WorkspaceDescriptorPayload;

    const workspace = normalizeWorkspaceDescriptor(payload);

    expect(workspace.services).toEqual([]);
  });
});

describe("mergeWorkspaces", () => {
  it("preserves services on merged workspace entries", () => {
    const store = useSessionStore.getState();
    store.initializeSession("test-server", null as unknown as DaemonClient);
    store.setWorkspaces(
      "test-server",
      new Map([["/repo/main", workspace({ id: "/repo/main", services: [] })]]),
    );

    store.mergeWorkspaces("test-server", [
      workspace({
        id: "/repo/main",
        services: [
          {
            serviceName: "web",
            hostname: "main.web.localhost",
            port: 3000,
            url: "http://main.web.localhost:6767",
            status: "running",
          },
        ],
      }),
    ]);

    expect(store.getSession("test-server")?.workspaces.get("/repo/main")?.services).toEqual([
      {
        serviceName: "web",
        hostname: "main.web.localhost",
        port: 3000,
        url: "http://main.web.localhost:6767",
        status: "running",
      },
    ]);
  });
});
