import { describe, expect, it } from "vitest";
import type { WorkspaceServicePayload } from "@server/shared/messages";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { patchWorkspaceServices } from "./session-workspace-services";

function workspace(input: {
  id: string;
  services?: WorkspaceDescriptor["services"];
}): WorkspaceDescriptor {
  return {
    id: input.id,
    projectId: "project-1",
    projectDisplayName: "Project 1",
    projectRootPath: "/repo",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "main",
    status: "running",
    activityAt: null,
    diffStat: null,
    services: input.services ?? [],
  };
}

const runningService: WorkspaceServicePayload = {
  serviceName: "web",
  hostname: "main.web.localhost",
  port: 3000,
  url: "http://main.web.localhost:6767",
  status: "running",
};

describe("patchWorkspaceServices", () => {
  it("patches only the matching workspace services", () => {
    const other = workspace({ id: "/repo/other", services: [] });
    const current = new Map<string, WorkspaceDescriptor>([
      ["/repo/main", workspace({ id: "/repo/main", services: [] })],
      [other.id, other],
    ]);

    const next = patchWorkspaceServices(current, {
      workspaceId: "/repo/main",
      services: [runningService],
    });

    expect(next).not.toBe(current);
    expect(next.get("/repo/main")?.services).toEqual([runningService]);
    expect(next.get("/repo/other")).toBe(other);
  });

  it("ignores updates for unknown workspaces", () => {
    const current = new Map<string, WorkspaceDescriptor>([
      ["/repo/main", workspace({ id: "/repo/main", services: [] })],
    ]);

    const next = patchWorkspaceServices(current, {
      workspaceId: "/repo/missing",
      services: [runningService],
    });

    expect(next).toBe(current);
    expect(next.get("/repo/main")?.services).toEqual([]);
  });
});
